-- 2P-APT3 (#159): booking RPCs for guests and staff with race-free capacity.
-- Race-freedom: every booking, cancel and (later) reschedule takes a transaction advisory lock on the
-- location, so capacity checks and the count-table updates of concurrent callers run one at a time.
-- The slot listing is refactored so the booking code reuses it (one owner of the slot rules):
-- private.slot_candidates returns the staff who could take each slot; private.available_slots keeps
-- its signature and now only trims that to the public three columns.

alter table app.locations add column booking_rate_per_min int not null default 30 check (booking_rate_per_min > 0);

-- Contact details stay on the appointment, like on a visit (X-3): an anonymous booking never writes the
-- org's contact book. Staff bookings link or create a contact as a staff join does.
alter table app.appointments add column guest_phone_e164 text, add column guest_email text, add column locale text;

-- Staff never read the token hash or the idempotency key: with the key anyone could re-derive the link.
revoke select on app.appointments from authenticated;
grant select (id, org_id, location_id, service_id, queue_id, staff_user_id, starts_at, ends_at, local_date,
              status, guest_name, guest_id, contact_id, guest_phone_e164, guest_email, locale, source,
              visit_id, version, cancelled_reason, created_at) on app.appointments to authenticated;

create type private.slot_candidate as (slot_start timestamptz, slot_end timestamptz, remaining int,
                                       free_staff uuid[], any_staff boolean);

create function private.slot_candidates(p_service_id uuid, p_from date, p_to date, p_now timestamptz default now(), p_ignore_capacity boolean default false)
returns setof private.slot_candidate
language plpgsql stable set search_path = '' as $$
declare
  s app.services;
  bp app.booking_policies;
  l app.locations;
  dur int;
  today date;
  has_rules boolean;
begin
  select * into s from app.services where id = p_service_id and active;
  select * into bp from app.booking_policies where service_id = p_service_id and bookable;
  if s.id is null or bp.id is null then return; end if;
  select * into l from app.locations where id = s.location_id;
  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then return; end if;
  dur := coalesce(bp.duration_minutes, s.expected_minutes);
  today := (p_now at time zone l.tz)::date;
  has_rules := exists (select 1 from app.availability_rules r
                       where r.location_id = l.id and (r.service_id is null or r.service_id = s.id));

  return query
  with days as (
    select gs::date as d from generate_series(greatest(p_from, today), least(p_to, today + bp.max_days_ahead), '1 day') gs
  ),
  biz as ( -- opening windows as instants (a window may cross midnight)
    select d.d,
           (d.d + o.opens) at time zone l.tz as w_start,
           (d.d + case when o.closes <= o.opens then 1 else 0 end + o.closes) at time zone l.tz as w_end
    from days d
    cross join lateral (
      select e.opens, e.closes from app.hours_exceptions e
      where e.location_id = l.id and e.date = d.d and not e.closed
      union all
      select h.opens, h.closes from app.business_hours h
      where h.location_id = l.id and h.weekday = extract(dow from d.d)
        and not exists (select 1 from app.hours_exceptions e where e.location_id = l.id and e.date = d.d)
    ) o
  ),
  avail as ( -- availability windows per staff member (null = any staff)
    select d.d, r.staff_user_id,
           (d.d + r.starts) at time zone l.tz as a_start,
           (d.d + case when r.ends <= r.starts then 1 else 0 end + r.ends) at time zone l.tz as a_end
    from days d join app.availability_rules r
      on r.location_id = l.id and (r.service_id is null or r.service_id = s.id)
     and r.weekday = extract(dow from d.d)
     and (r.valid_from is null or d.d >= r.valid_from) and (r.valid_to is null or d.d <= r.valid_to)
    union all
    select x.local_date, x.staff_user_id,
           (x.local_date + x.starts) at time zone l.tz,
           (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'extra' and x.local_date between p_from and p_to
  ),
  off as ( -- unavailable windows (null staff = everyone; null times = the whole day)
    select x.staff_user_id,
           tstzrange((x.local_date + coalesce(x.starts, time '00:00')) at time zone l.tz,
                     case when x.starts is null then (x.local_date + 1) at time zone l.tz
                          else (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz end) as r
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'unavailable' and x.local_date between p_from - 1 and p_to
  ),
  cand as (
    select (b.w_start + m * interval '1 minute') as st,
           (b.w_start + (m + dur) * interval '1 minute') as en,
           b.d
    from biz b
    cross join lateral generate_series(bp.slot_offset_minutes,
        (extract(epoch from (b.w_end - b.w_start)) / 60)::int - dur, bp.slot_minutes) m
  ),
  checked as (
    select c.st, c.en, c.d,
      -- staff who could take the slot: covered by an availability window, not off, not double-booked
      (select coalesce(array_agg(distinct a.staff_user_id), '{}'::uuid[]) from avail a
        where a.staff_user_id is not null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en
          and not exists (select 1 from off f where (f.staff_user_id is null or f.staff_user_id = a.staff_user_id)
                          and f.r && tstzrange(c.st, c.en))
          and not exists (select 1 from app.appointments ap
                          where ap.staff_user_id = a.staff_user_id and ap.status in ('booked', 'checked_in')
                            and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
                            and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                                          ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en))
      ) as free_staff,
      exists (select 1 from avail a where a.staff_user_id is null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en) as any_staff,
      exists (select 1 from off f where f.staff_user_id is null and f.r && tstzrange(c.st, c.en)) as closed_all,
      (select count(*)::int from app.appointments ap
        where (bp.buffer_before_minutes > 0 or bp.buffer_after_minutes > 0)
          and ap.service_id = s.id and ap.staff_user_id is null and ap.status in ('booked', 'checked_in')
          and ap.starts_at <> c.st and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
          and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                        ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en)) as overlap,
      coalesce((select cr.capacity from app.capacity_rules cr
                where cr.service_id = s.id and cr.scope = 'slot'
                  and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
                order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1), 1) as cap,
      (select cr.capacity from app.capacity_rules cr
        where cr.service_id = s.id and cr.scope = 'day'
          and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
        order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1) as day_cap,
      coalesce((select n.count from app.appointment_slot_counts n where n.service_id = s.id and n.slot_start = c.st), 0) as used,
      coalesce((select n.count from app.appointment_day_counts n where n.service_id = s.id and n.local_date = c.d), 0) as day_used
    from cand c
    where c.st >= p_now + bp.min_notice_minutes * interval '1 minute'
  )
  select k.st, k.en,
         case when p_ignore_capacity then 1 else least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end)::int end,
         k.free_staff, k.any_staff
  from checked k
  where not k.closed_all
    and (not has_rules or k.any_staff or cardinality(k.free_staff) > 0)
    and (p_ignore_capacity or least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end) > 0)
  order by k.st;
end $$;

comment on function private.slot_candidates(uuid, date, date, timestamptz, boolean) is
  'The slot rules (see 20261030062750_appointments.sql for the semantics): every slot of a service in a '
  'date range with its remaining seats and the staff who could take it. p_ignore_capacity lists slots '
  'that are valid but full, which is how booking tells slot_unavailable from slot_full.';
revoke all on function private.slot_candidates(uuid, date, date, timestamptz, boolean) from public, anon, authenticated;

-- redefines private.available_slots from 20261030062750_appointments.sql
create or replace function private.available_slots(p_service_id uuid, p_from date, p_to date, p_now timestamptz default now())
returns setof api.available_slot
language sql stable set search_path = '' as $$
  select c.slot_start, c.slot_end, c.remaining from private.slot_candidates(p_service_id, p_from, p_to, p_now) c
$$;
comment on function private.available_slots(uuid, date, date, timestamptz) is
  'Bookable slots of a service for local dates from..to: private.slot_candidates trimmed to start, end '
  'and remaining seats. Empty for non-bookable or inactive services and non-active orgs.';

create function private.take_capacity(p_org_id uuid, p_service_id uuid, p_slot_start timestamptz, p_local_date date)
returns void language sql volatile set search_path = '' as $$
  insert into app.appointment_slot_counts as n (org_id, service_id, slot_start, count)
  values (p_org_id, p_service_id, p_slot_start, 1)
  on conflict (service_id, slot_start) do update set count = n.count + 1;
  insert into app.appointment_day_counts as n (org_id, service_id, local_date, count)
  values (p_org_id, p_service_id, p_local_date, 1)
  on conflict (service_id, local_date) do update set count = n.count + 1;
$$;
create function private.release_capacity(p_appointment app.appointments) returns void
language sql volatile set search_path = '' as $$
  update app.appointment_slot_counts set count = greatest(count - 1, 0)
  where service_id = p_appointment.service_id and slot_start = p_appointment.starts_at;
  update app.appointment_day_counts set count = greatest(count - 1, 0)
  where service_id = p_appointment.service_id and local_date = p_appointment.local_date;
$$;
-- One lock per location: the staff-conflict check spans services, so per-service locks would let two
-- services double-book the same staff member.
create function private.lock_location(p_location_id uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('appointments:' || p_location_id::text, 0))
$$;
revoke all on function private.take_capacity(uuid, uuid, timestamptz, date), private.release_capacity(app.appointments),
  private.lock_location(uuid) from public, anon, authenticated;

create type api.booking_result as (token text, starts_at timestamptz, ends_at timestamptz,
                                   service_name text, location_name text, status text);
create type api.appointment_row as (id uuid, location_id uuid, service_id uuid, staff_user_id uuid,
                                    starts_at timestamptz, ends_at timestamptz, status text,
                                    guest_name text, visit_id uuid, version int);
grant usage on type api.booking_result, api.appointment_row to anon, authenticated, service_role;

-- The one booking path. Returns the appointment (new, or the earlier one for a repeated key).
create function private.book_core(
  p_location_id uuid, p_service_id uuid, p_slot_start timestamptz, p_staff_user_id uuid, p_name text,
  p_phone_e164 text, p_email text, p_party_size int, p_locale text, p_idempotency_key uuid,
  p_source text, p_actor_kind app.actor_kind, p_actor_id uuid, p_override boolean,
  out appointment app.appointments, out is_new boolean
)
language plpgsql volatile set search_path = '' as $$
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

  v_date := (p_slot_start at time zone l.tz)::date;
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
  values (v_id, l.org_id, l.id, s.id, s.queue_id, v_staff, slot.slot_start, slot.slot_end, v_date, v_name,
          v_guest, v_contact, v_phone, v_email,
          coalesce(v_locale, (select o.default_locale from app.organizations o where o.id = l.org_id)),
          case when p_source = 'guest' then private.token_hash(private.visit_token(v_id, p_idempotency_key)) end,
          p_source, p_idempotency_key)
  returning * into appointment;
  perform private.take_capacity(l.org_id, s.id, slot.slot_start, v_date);
end $$;
comment on function private.book_core(uuid, uuid, timestamptz, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, boolean) is
  'Books one slot under a per-service advisory lock. Idempotent per (location, key): a repeat returns the '
  'first appointment (is_new false) and consumes nothing. Raises not_found, invalid_input, org_suspended, '
  'rate_limited (guests), slot_unavailable (not a valid slot, or the staff member is not free) and slot_full.';
revoke all on function private.book_core(uuid, uuid, timestamptz, uuid, text, text, text, int, text, uuid, text, app.actor_kind, uuid, boolean)
  from public, anon, authenticated;

create function api.book_appointment(
  p_location_slug text, p_service_id uuid, p_slot_start timestamptz, p_name text, p_phone_e164 text,
  p_email text, p_party_size int, p_locale text, p_idempotency_key uuid
) returns api.booking_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.locations;
  booked record;
  result api.booking_result;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null then raise exception 'not_found'; end if;
  select * into booked from private.book_core(l.id, p_service_id, p_slot_start, null, p_name, p_phone_e164,
    p_email, p_party_size, p_locale, p_idempotency_key, 'guest', 'guest', null, false);
  select private.visit_token((booked.appointment).id, p_idempotency_key), (booked.appointment).starts_at,
         (booked.appointment).ends_at, s.name, l.name, (booked.appointment).status::text
  into result from app.services s where s.id = (booked.appointment).service_id;
  return result;
end $$;
comment on function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid) is
  'Anonymous booking of one slot returned by get_available_slots. Status, org, staff and source are '
  'derived on the server, never accepted. Idempotent per (location, p_idempotency_key): a repeat returns '
  'the same booking and token and consumes no capacity. The token is derived from the appointment and '
  'the key, stored only as sha256. Raises not_found, invalid_input, party_size_out_of_range, '
  'org_suspended, rate_limited, slot_unavailable and slot_full.';
revoke all on function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid) from public;
grant execute on function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid) to anon, authenticated, service_role;

create function private.appointment_row(p_a app.appointments) returns api.appointment_row
language sql immutable set search_path = '' as $$
  select row(p_a.id, p_a.location_id, p_a.service_id, p_a.staff_user_id, p_a.starts_at, p_a.ends_at,
             p_a.status::text, p_a.guest_name, p_a.visit_id, p_a.version)::api.appointment_row
$$;
revoke all on function private.appointment_row(app.appointments) from public, anon, authenticated;

create function api.staff_book_appointment(
  p_location_id uuid, p_service_id uuid, p_slot_start timestamptz, p_staff_user_id uuid, p_name text,
  p_phone_e164 text, p_email text, p_party_size int, p_override_capacity boolean, p_idempotency_key uuid
) returns api.appointment_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.locations;
  booked record;
  uid uuid := (select auth.uid());
begin
  select * into l from app.locations where id = p_location_id;
  if l.id is null or not (select private.has_role(l.org_id, l.id, 'staff')) then raise exception 'not_found'; end if;
  if coalesce(p_override_capacity, false) and not (select private.has_role(l.org_id, l.id, 'manager')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into booked from private.book_core(l.id, p_service_id, p_slot_start, p_staff_user_id, p_name,
    p_phone_e164, p_email, p_party_size, null, p_idempotency_key, 'staff', 'staff', uid, coalesce(p_override_capacity, false));
  if booked.is_new and coalesce(p_override_capacity, false) then
    insert into app.audit_log (org_id, actor, role, action, table_name, row_id, after)
    values (l.org_id, uid, 'manager', 'INSERT', 'appointments', (booked.appointment).id::text,
            jsonb_build_object('override_capacity', true, 'slot_start', p_slot_start));
  end if;
  return private.appointment_row(booked.appointment);
end $$;
comment on function api.staff_book_appointment(uuid, uuid, timestamptz, uuid, text, text, text, int, boolean, uuid) is
  'Staff (or manager) books a slot for a guest, optionally with a chosen staff member. p_override_capacity '
  'lets manager and up book a full slot and is written to the audit log. Idempotent per (location, key). '
  'Raises not_found (unknown location or no staff role there), permission_denied (override by staff), '
  'and the errors of book_appointment.';
revoke all on function api.staff_book_appointment(uuid, uuid, timestamptz, uuid, text, text, text, int, boolean, uuid) from public, anon;
grant execute on function api.staff_book_appointment(uuid, uuid, timestamptz, uuid, text, text, text, int, boolean, uuid) to authenticated, service_role;

create function api.staff_cancel_appointment(p_appointment_id uuid, p_expected_version int, p_reason text, p_idempotency_key uuid)
returns api.appointment_row
language plpgsql volatile security definer set search_path = '' as $$
declare a app.appointments;
begin
  select * into a from app.appointments where id = p_appointment_id;
  if a.id is null or not (select private.has_role(a.org_id, a.location_id, 'staff')) then raise exception 'not_found'; end if;
  perform private.lock_location(a.location_id);
  select * into a from app.appointments where id = p_appointment_id;
  if a.status = 'cancelled' then return private.appointment_row(a); end if;
  if a.version <> p_expected_version then raise exception 'stale_visit'; end if;
  if a.status <> 'booked' then raise exception 'illegal_transition'; end if;
  perform private.set_actor('staff', (select auth.uid()), 'cancel', left(btrim(p_reason), 200));
  update app.appointments set status = 'cancelled', cancelled_reason = left(nullif(btrim(p_reason), ''), 200)
  where id = a.id returning * into a;
  perform private.release_capacity(a);
  return private.appointment_row(a);
end $$;
comment on function api.staff_cancel_appointment(uuid, int, text, uuid) is
  'Staff cancels a booked appointment and releases its capacity. Repeating is a no-op that returns the '
  'cancelled row. Raises not_found (unknown, or another org), stale_visit (version moved) and '
  'illegal_transition (already checked in, completed or no-show).';
revoke all on function api.staff_cancel_appointment(uuid, int, text, uuid) from public, anon;
grant execute on function api.staff_cancel_appointment(uuid, int, text, uuid) to authenticated, service_role;
