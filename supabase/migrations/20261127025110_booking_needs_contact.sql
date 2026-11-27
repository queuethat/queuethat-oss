-- Appointments need a way to reach the guest (confirmation, reminders, changes): a phone or an email.
-- Walk-ins stay contact-optional and are not touched. Staff and guest bookings share this one rule.
-- redefines private.book_core from 20261122085036_location_services_switch.sql
CREATE OR REPLACE FUNCTION private.book_core(p_location_id uuid, p_service_id uuid, p_slot_start timestamp with time zone, p_staff_user_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size integer, p_locale text, p_idempotency_key uuid, p_source text, p_actor_kind app.actor_kind, p_actor_id uuid, p_override boolean, OUT appointment app.appointments, OUT is_new boolean)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  l app.locations;
  s app.services;
  bp app.booking_policies;
  slot private.slot_candidate;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_locale text := nullif(btrim(p_locale), '');
  v_date date;
  v_staff uuid;
  v_guest uuid;
  v_contact uuid;
  v_email_contact uuid;
  v_id uuid := gen_random_uuid();
begin
  select * into l from app.locations where id = p_location_id;
  select * into s from app.services where id = p_service_id and location_id = p_location_id;
  if l.id is null or s.id is null then raise exception 'not_found'; end if;
  if p_idempotency_key is null or p_slot_start is null
     or v_name is null or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_phone !~ '^\+[1-9][0-9]{6,14}$'
     or length(v_locale) > 35 or v_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
     or length(v_email) > 254
     or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$' then
    raise exception 'invalid_input';
  end if;
  -- A blank phone or email normalizes to null above, and null slips past the format checks.
  if v_phone is null and v_email is null then raise exception 'contact_required'; end if;
  if coalesce(p_party_size, 1) <> 1 then raise exception 'party_size_out_of_range'; end if;
  perform private.lock_location(l.id);

  select a.* into appointment from app.appointments a
  where a.location_id = l.id and a.idempotency_key = p_idempotency_key;
  if found then
    is_new := false;
    return;
  end if;
  is_new := true;

  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then
    raise exception 'org_suspended';
  end if;
  if p_source = 'guest' then
    if private.is_blocked(l.org_id, v_phone, v_email) then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    -- one phone or email cannot hold more than 3 upcoming bookings in the org
    if (select count(*) from app.appointments a
        where a.org_id = l.org_id and a.status = 'booked' and a.starts_at > now()
          and ((v_phone is not null and a.guest_phone_e164 = v_phone)
               or (v_email is not null and a.guest_email = v_email))) >= 3 then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    if (select count(*) from app.appointments a
        where a.location_id = l.id and a.source = 'guest' and a.created_at > now() - interval '1 minute') >= l.booking_rate_per_min then
      raise exception 'rate_limited' using detail = 'network';
    end if;
  end if;

  v_date := (p_slot_start at time zone private.zone(l.tz))::date;
  -- Valid at all (hours, grid, notice, horizon, staff)? Then is there room?
  select c.* into slot from private.slot_candidates(s.id, v_date - 1, v_date + 1, now(), true) c
  where c.slot_start = p_slot_start;
  if slot.slot_start is null then raise exception 'slot_unavailable'; end if;
  if not coalesce(p_override, false) and not exists (
       select 1 from private.slot_candidates(s.id, v_date - 1, v_date + 1) c where c.slot_start = p_slot_start) then
    raise exception 'slot_full';
  end if;

  v_staff := p_staff_user_id;
  if v_staff is not null then
    if not (v_staff = any (slot.free_staff)) and not (slot.any_staff and exists (
         select 1 from app.memberships m where m.org_id = l.org_id and m.user_id = v_staff)) then
      raise exception 'slot_unavailable';
    end if;
  elsif cardinality(slot.free_staff) > 0 then -- the least booked that day takes it
    select f into v_staff from unnest(slot.free_staff) f
    order by (select count(*) from app.appointments a where a.staff_user_id = f and a.local_date = v_date
                and a.status in ('booked', 'checked_in')), f limit 1;
  end if;

  if p_source = 'staff' then -- staff see the guest, so staff bookings record or link the contact
    if v_phone is not null then
      select c.contact_id, c.guest_id into v_contact, v_guest
      from private.ensure_contact(l.org_id, 'phone', v_phone, null, v_name, p_source, true) c;
    end if;
    if v_email is not null then
      select c.contact_id, coalesce(v_guest, c.guest_id) into v_email_contact, v_guest
      from private.ensure_contact(l.org_id, 'email', v_email, v_guest, v_name, p_source, true) c;
      v_contact := coalesce(v_contact, v_email_contact);
    end if;
  end if;

  select bp2.* into bp from app.booking_policies bp2 where bp2.service_id = s.id;
  perform private.set_actor(p_actor_kind, p_actor_id, null, null, jsonb_build_object('source', p_source));
  insert into app.appointments (id, org_id, location_id, service_id, queue_id, staff_user_id, starts_at, ends_at,
                                local_date, guest_name, guest_id, contact_id, guest_phone_e164, guest_email, locale,
                                guest_token_hash, source, idempotency_key)
  values (v_id, l.org_id, l.id, s.id, private.service_queue(s.id), v_staff, slot.slot_start, slot.slot_end, v_date, v_name,
          v_guest, v_contact, v_phone, v_email,
          coalesce(v_locale, (select o.default_locale from app.organizations o where o.id = l.org_id)),
          case when p_source = 'guest' then private.token_hash(private.visit_token(v_id, p_idempotency_key)) end,
          p_source, p_idempotency_key)
  returning * into appointment;
  perform private.take_capacity(l.org_id, s.id, slot.slot_start, v_date);
end $function$;

comment on function private.book_core(uuid, uuid, timestamptz, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, boolean) is
  'Books one slot under a per-service advisory lock. Idempotent per (location, key): a repeat returns the '
  'first appointment (is_new false) and consumes nothing. Needs a phone or an email so the guest can be '
  'reached. Raises not_found, invalid_input, contact_required (neither phone nor email), org_suspended, '
  'rate_limited (guests), slot_unavailable (not a valid slot, or the staff member is not free) and slot_full.';
