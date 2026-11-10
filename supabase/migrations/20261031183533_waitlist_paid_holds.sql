-- Waitlist bypass of the paid-hold controls (security review of the pending hold cap):
--   * guest_join_waitlist had no Turnstile check, and a claimed offer becomes a pending paid hold that skipped
--     both the pass and the cap, so waitlist entries could keep slots held without a challenge.
--     Now a new entry for a paid service (payment policy and a connected processor, the same predicate as
--     book_appointment) spends a join pass scoped to this service and key; a replay needs none.
--   * An open offer (status 'offered') holds a seat just like an unpaid hold, so it counts toward the cap of 20
--     per service and day (private.live_holds). Counting claims instead would let a full cap burn real guests'
--     offers. Instead private.offer_freed_slot makes no offer while the cap is full, so the entry keeps waiting
--     for the next freed slot, and a claim converts an offer already counted, so it is never refused for the cap.
--   * The waitlist pass is scoped to the service, the booking pass to the location, so one solve cannot buy both.
-- Alternatives rejected: (1) a pass on guest_claim_offer, which would challenge a guest mid-claim on a phone instead
-- of the one who creates the entry; (2) refusing the claim when the cap is full (an attacker keeping the cap full
-- would make every real offer expire); (3) exempting offers from the cap, which is the hole.
-- Accepted: entries made before this migration (service free, no processor or no Turnstile key at the time) spend no
-- pass; they stay bounded by the cap, 3 per email and 50 per location-day.
-- redefines private.offer_freed_slot from 20261030172458_slot_waitlist.sql
-- redefines private.require_card_on_booking from 20261031175820_pending_hold_cap.sql
-- redefines api.guest_join_waitlist from 20261030172458_slot_waitlist.sql

create function private.live_holds(p_service_id uuid, p_local_date date) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from app.appointments a
  where a.service_id = p_service_id and a.local_date = p_local_date
    and (a.payment_due_at > now() or a.status::text = 'offered')
$$;
comment on function private.live_holds(uuid, date) is
  'Seats a service has held on a local day without a paid or confirmed booking: unpaid holds not yet due, and open waitlist offers.';
revoke all on function private.live_holds(uuid, date) from public, anon, authenticated;

create or replace function private.require_card_on_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pol app.payment_policies;
begin
  -- Only the moments a guest booking is born: a new row, or a waitlist offer being claimed.
  if new.status::text = 'booked' and new.source = 'guest' and new.event_id is null and new.guest_token_hash is not null
     and (tg_op = 'INSERT' or old.status::text = 'offered') then
    select * into pol from app.payment_policies x
    where x.org_id = new.org_id and x.service_id = new.service_id and x.mode <> 'none'
      and private.payments_connected(x.org_id);
    if found then
      -- The cap below needs a contact to count against.
      if new.guest_phone_e164 is null and new.guest_email is null then raise exception 'invalid_input'; end if;
      -- Unpaid bookings hold slots, so one contact cannot hold more than 3 at once.
      if (select count(*) from app.appointments a
          where a.org_id = new.org_id and a.payment_due_at > now() and a.id <> new.id
            and ((new.guest_phone_e164 is not null and a.guest_phone_e164 = new.guest_phone_e164)
                 or (new.guest_email is not null and a.guest_email = new.guest_email))) >= 3 then
        raise exception 'rate_limited' using detail = 'client';
      end if;
      -- Contacts are free to invent, so one service's holds on one local day are capped as well. Scoped to the
      -- day, not the location: 20 holds must not lock real guests out of every other day and service.
      -- book_core holds the per-location advisory lock, so this count-then-insert is serialised.
      if tg_op = 'INSERT' and private.live_holds(new.service_id, new.local_date) >= 20 then
        raise exception 'rate_limited' using detail = 'day_holds';
      end if;
      new.status := 'pending_payment';
    end if;
  end if;
  new.payment_due_at := case when new.status::text <> 'pending_payment' then null
                             when tg_op = 'UPDATE' and old.payment_due_at is not null then old.payment_due_at
                             else now() + make_interval(mins => coalesce(pol.pay_within_minutes, 15)) end;
  return new;
end $$;

create or replace function private.offer_freed_slot(p_a app.appointments) returns void
language plpgsql volatile set search_path = '' as $$
declare
  l app.locations;
  s app.services;
  w app.slot_waitlist;
  held app.appointments;
  v_expires timestamptz;
  saved text[];
begin
  if p_a.event_id is not null or p_a.starts_at <= now() then return; end if;
  if not exists (select 1 from private.slot_candidates(p_a.service_id, p_a.local_date - 1, p_a.local_date + 1) c
                 where c.slot_start = p_a.starts_at) then
    return;
  end if;
  -- Offers hold seats like unpaid holds, so none is made while a paid service's cap is full; the entry keeps waiting.
  if exists (select 1 from app.payment_policies x where x.org_id = p_a.org_id and x.service_id = p_a.service_id and x.mode <> 'none')
     and private.payments_connected(p_a.org_id) and private.live_holds(p_a.service_id, p_a.local_date) >= 20 then
    return;
  end if;
  select x.* into w from app.slot_waitlist x
  where x.service_id = p_a.service_id and x.status = 'waiting' and x.wanted_day = p_a.local_date
    and (x.during is null or x.during @> p_a.starts_at)
  order by x.created_at, x.id limit 1 for update skip locked;
  if w.id is null then return; end if;
  select * into l from app.locations where id = p_a.location_id;
  select * into s from app.services where id = p_a.service_id;
  v_expires := least(now() + make_interval(mins => l.waitlist_hold_minutes), p_a.starts_at);
  -- The caller's actor context (a staff cancel, say) must survive this offer.
  saved := array[current_setting('app.actor_kind', true), current_setting('app.actor_id', true),
                 current_setting('app.action', true), current_setting('app.reason', true),
                 current_setting('app.event_payload', true)];
  perform private.set_actor('system', null, 'waitlist_offer');
  insert into app.appointments (org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, status, guest_name,
                                guest_phone_e164, guest_email, locale, guest_token_hash, source, idempotency_key)
  values (p_a.org_id, p_a.location_id, p_a.service_id, s.queue_id, p_a.starts_at, p_a.ends_at, p_a.local_date, 'offered', w.name,
          w.guest_phone_e164, w.guest_email,
          (select o.default_locale from app.organizations o where o.id = p_a.org_id), w.token_hash, 'guest', gen_random_uuid())
  returning * into held;
  perform private.take_capacity(held.org_id, held.service_id, held.starts_at, held.local_date);
  update app.slot_waitlist set status = 'offered', offered_slot = tstzrange(held.starts_at, held.ends_at),
         offer_expires_at = v_expires, appointment_id = held.id where id = w.id;
  perform private.enqueue_appointment_notification(held, 'slot_offer', jsonb_build_object(
    'service', s.name, 'offer_expires', to_char(v_expires at time zone l.tz, 'HH24:MI')));
  if saved[1] is not null then
    perform set_config('app.actor_kind', saved[1], true), set_config('app.actor_id', coalesce(saved[2], ''), true),
            set_config('app.action', coalesce(saved[3], ''), true), set_config('app.reason', coalesce(saved[4], ''), true),
            set_config('app.event_payload', coalesce(saved[5], '{}'), true);
  end if;
end $$;
comment on function private.offer_freed_slot(app.appointments) is
  'Holds the slot p_a just vacated for the oldest waiting guest who wants that day and window, if the slot is bookable '
  'again and in the future. The hold is an appointment in status offered that takes the slot''s capacity until the offer is '
  'claimed, left or expired. Queues one slot_offer message.';

drop function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid);
create function api.guest_join_waitlist(
  p_location_slug text, p_service_id uuid, p_wanted_day date, p_window_start time, p_window_end time,
  p_name text, p_phone_e164 text, p_email text, p_idempotency_key uuid, p_join_pass text default null
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.locations;
  s app.services;
  w app.slot_waitlist;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_today date;
  v_id uuid := gen_random_uuid();
  v_during tstzrange;
begin
  select * into l from app.locations where slug = p_location_slug;
  if l.id is null then raise exception 'not_found'; end if;
  select * into s from app.services where id = p_service_id and location_id = l.id;
  if s.id is null or not exists (select 1 from app.booking_policies bp where bp.service_id = s.id and bp.bookable) then
    raise exception 'not_found';
  end if;
  v_today := (now() at time zone l.tz)::date;
  if p_idempotency_key is null or v_name is null or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or v_email is null or length(v_email) > 254
     or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$'
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$')
     or p_wanted_day is null or p_wanted_day < v_today or p_wanted_day > v_today + 90
     or (p_window_start is null) <> (p_window_end is null) or p_window_end <= p_window_start then
    raise exception 'invalid_input';
  end if;
  perform private.lock_location(l.id);
  select x.* into w from app.slot_waitlist x where x.location_id = l.id and x.idempotency_key = p_idempotency_key;
  if found then
    if w.service_id <> s.id then raise exception 'invalid_input'; end if;
    return private.visit_token(w.id, p_idempotency_key);
  end if;
  -- A claimed offer becomes a pending paid hold, so a waitlist entry for a paid service is gated like a booking:
  -- a replay (above) needs no pass, a new entry spends one, scoped to this service and key.
  if exists (select 1 from app.payment_policies x where x.org_id = l.org_id and x.service_id = s.id and x.mode <> 'none')
     and private.payments_connected(l.org_id) then
    perform private.spend_join_pass(p_join_pass, s.id, p_idempotency_key);
  end if;
  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then
    raise exception 'org_suspended';
  end if;
  if private.is_blocked(l.org_id, v_phone, v_email) then raise exception 'rate_limited' using detail = 'client'; end if;
  -- one address cannot wait on more than 3 slots at once
  if (select count(*) from app.slot_waitlist x where x.org_id = l.org_id and x.status in ('waiting', 'offered')
        and x.guest_email = v_email) >= 3 then
    raise exception 'rate_limited' using detail = 'client';
  end if;
  -- a day's waitlist is bounded, so a flood of entries cannot absorb every freed slot of that day
  if (select count(*) from app.slot_waitlist x where x.location_id = l.id and x.wanted_day = p_wanted_day
        and x.status in ('waiting', 'offered')) >= 50 then
    raise exception 'rate_limited' using detail = 'network';
  end if;
  if (select count(*) from app.slot_waitlist x where x.location_id = l.id and x.created_at > now() - interval '1 minute')
       >= l.booking_rate_per_min then
    raise exception 'rate_limited' using detail = 'network';
  end if;
  if p_window_start is not null then
    v_during := tstzrange((p_wanted_day + p_window_start) at time zone l.tz, (p_wanted_day + p_window_end) at time zone l.tz);
  end if;
  insert into app.slot_waitlist (id, org_id, location_id, service_id, wanted_day, during, name, guest_phone_e164, guest_email,
                                 token_hash, idempotency_key)
  values (v_id, l.org_id, l.id, s.id, p_wanted_day, v_during, v_name, v_phone, v_email,
          private.token_hash(private.visit_token(v_id, p_idempotency_key)), p_idempotency_key);
  return private.visit_token(v_id, p_idempotency_key);
end $$;
comment on function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid, text) is
  'Anonymous: waits for any slot of a bookable service on a local day (today to 90 days ahead), optionally within a local '
  'time window. An email is required (offers are emailed; a typed phone is never texted). Returns the waitlist token, '
  'stored only as sha256, which opens the offer page and later the appointment. Idempotent per (location, key). '
  'When the deployment has a Turnstile site key and the service has a payment policy with a connected processor, a new '
  'entry needs p_join_pass from api.issue_join_pass (a replay needs none), because claiming the offer creates a paid hold. '
  'Raises not_found, invalid_input, captcha_required, org_suspended and rate_limited. Added because no phase-0 stub covers joining: the '
  'booking functions need a slot, and a full day has none.';
revoke all on function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid, text) from public;
grant execute on function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
