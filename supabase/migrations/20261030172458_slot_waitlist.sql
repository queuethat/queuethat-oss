-- 2B-A1 (#276): slot waitlist with auto-offer of freed slots.
-- An offer is a HELD APPOINTMENT (status 'offered'): it takes slot capacity like a booking, so a freed seat
-- cannot be given twice (a staff booking or another claim sees the slot full), and its offer message rides the
-- existing appointment outbox. Claiming flips the held row to 'booked'. Every seat-freeing path already calls
-- private.release_capacity, so that is the one hook that offers the seat to the oldest matching waiting guest.
-- The waitlist token is also the held appointment's token, so one link serves the offer page and get_appointment.
-- Offer messages cannot carry the link (tokens are stored hashed): they tell the guest to open their waitlist link.
--
-- Alternative rejected: a separate waitlist subject on app.notifications. It needs claim_outbox,
-- notification_address, unsubscribe_outbox and outbox_still_relevant to learn a third subject kind, all anon-adjacent.
--
-- redefines private.release_capacity from 20261030170603_events.sql
-- redefines api.outbox_still_relevant from 20261030170603_events.sql

alter type app.appointment_status add value if not exists 'offered';

create type app.waitlist_status as enum ('waiting', 'offered', 'claimed', 'expired', 'cancelled');
grant usage on type app.waitlist_status to anon, authenticated, service_role;

alter table app.locations
  add column waitlist_hold_minutes int not null default 15 check (waitlist_hold_minutes between 1 and 1440);
comment on column app.locations.waitlist_hold_minutes is 'How long a freed slot is held for the guest it was offered to.';

create table app.slot_waitlist (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  wanted_day date not null,
  during tstzrange, -- the part of the day the guest accepts; null = any time
  name text not null check (length(btrim(name)) between 1 and 60),
  contact_id uuid,
  guest_phone_e164 text,
  guest_email text,
  token_hash bytea not null unique, -- sha256 only
  status app.waitlist_status not null default 'waiting',
  offered_slot tstzrange,
  offer_expires_at timestamptz,
  appointment_id uuid, -- the held (then booked) appointment
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  foreign key (org_id, service_id) references app.services (org_id, id),
  foreign key (org_id, appointment_id) references app.appointments (org_id, id),
  unique (org_id, id),
  unique (location_id, idempotency_key)
);
create index slot_waitlist_match_idx on app.slot_waitlist (service_id, wanted_day, created_at) where status = 'waiting';
create index slot_waitlist_offer_idx on app.slot_waitlist (offer_expires_at) where status = 'offered';

-- Contact data is kept only while the entry can still be offered a slot.
create function private.scrub_waitlist() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status in ('claimed', 'expired', 'cancelled') then
    new.name := '—'; new.guest_phone_e164 := null; new.guest_email := null; new.contact_id := null;
  end if;
  return new;
end $$;
create trigger scrub_waitlist before update on app.slot_waitlist
  for each row execute function private.scrub_waitlist();

alter table app.slot_waitlist enable row level security;
create policy slot_waitlist_select on app.slot_waitlist for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
grant select on app.slot_waitlist to authenticated;
grant all on app.slot_waitlist to service_role;

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer'));
insert into app.notification_templates (trigger, channel, subject, body)
select 'slot_offer', c.channel, case when c.channel = 'email' then 'A spot opened up' end,
       'A spot opened: {{service}} at {{location_name}}, {{appointment_time}}. It is held for you until {{offer_expires}}; open your waitlist link to claim it.' || c.suffix
from (values ('push'::app.notification_channel, ''), ('console'::app.notification_channel, ''),
             ('sms'::app.notification_channel, ''),
             ('email'::app.notification_channel, E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]')) c (channel, suffix);

-- Offers the seat that p_a just freed to the oldest waiting guest who wants that day and time.
create function private.offer_freed_slot(p_a app.appointments) returns void
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
revoke all on function private.offer_freed_slot(app.appointments) from public, anon, authenticated;

-- Every cancel, move, expiry and no-show-release path gives its seat back here, so this is where the next guest is offered it.
create or replace function private.release_capacity(p_appointment app.appointments) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if p_appointment.event_id is not null then
    update app.events set booked = greatest(booked - p_appointment.seats, 0) where id = p_appointment.event_id;
    return;
  end if;
  update app.appointment_slot_counts set count = greatest(count - 1, 0)
  where service_id = p_appointment.service_id and slot_start = p_appointment.starts_at;
  update app.appointment_day_counts set count = greatest(count - 1, 0)
  where service_id = p_appointment.service_id and local_date = p_appointment.local_date;
  perform private.offer_freed_slot(p_appointment);
end $$;

create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- A cancelled event's message is about the cancellation; it stands while the booking is cancelled.
      when n.appointment_id is not null and n.template_key = 'event_cancelled' then ap.status = 'cancelled'
      -- A slot offer is worth sending only while the guest's offer is still open.
      when n.appointment_id is not null and n.template_key = 'slot_offer' then
        ap.status::text = 'offered' and exists (select 1 from app.slot_waitlist w
                                                where w.appointment_id = ap.id and w.status = 'offered' and w.offer_expires_at > now())
      -- An appointment message goes only while the booking stands at the time it was queued for,
      -- and a reminder that quiet hours would hold back past the start is dropped, not sent late.
      when n.appointment_id is not null then
        ap.status = 'booked' and ap.starts_at > now()
        and floor(extract(epoch from ap.starts_at))::bigint = (n.vars ->> 'starts_epoch')::bigint
        and (n.channel = 'push' or n.template_key <> 'appointment_reminder'
             or private.quiet_hours_end(now(), l.tz) < ap.starts_at)
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- A reply to the guest's own HELP is not an alert: no preference or visit state applies.
      when n.template_key = 'help' then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l2
                        where l2.visit_id = v.id and l2.id > n.event_id and l2.type in ('call', 'recall'))
      -- The warning is about the current call: gone once the guest is served, left or was recalled.
      when n.template_key = 'no_show_warning' then v.status = 'called'
        and not exists (select 1 from app.visit_events l2
                        where l2.visit_id = v.id and l2.id > n.event_id and l2.type in ('call', 'recall'))
      -- Removal and service are about what happened; they stand unless the staff undid them.
      when n.template_key = 'removed' then v.status = 'removed' and e.undone_by_event_id is null
      when n.template_key = 'served' then v.status = 'served' and e.undone_by_event_id is null
      when n.template_key in ('almost_up', 'position_changed', 'eta_changed') then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.appointments ap on ap.id = n.appointment_id
    left join app.locations l on l.id = ap.location_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed or eta_changed once the guest is no longer waiting, called and no_show_warning after the guest moved on or was called again (called also after an undo), removed and served unless the staff undid them, a joined message for a finished visit, an appointment message whose booking changed (an event_cancelled message instead needs the booking cancelled), or an unknown id. Account mail is always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173), re-notify in 2P-NTF3 (#175), the remaining triggers in 2A-NT1 (#132), events in 2B-A3 (#278), a slot_offer message while its offer is open in 2B-A1 (#276).';

create function api.guest_join_waitlist(
  p_location_slug text, p_service_id uuid, p_wanted_day date, p_window_start time, p_window_end time,
  p_name text, p_phone_e164 text, p_email text, p_idempotency_key uuid
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
comment on function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid) is
  'Anonymous: waits for any slot of a bookable service on a local day (today to 90 days ahead), optionally within a local '
  'time window. An email is required (offers are emailed; a typed phone is never texted). Returns the waitlist token, '
  'stored only as sha256, which opens the offer page and later the appointment. Idempotent per (location, key). '
  'Raises not_found, invalid_input, org_suspended and rate_limited. Added because no phase-0 stub covers joining: the '
  'booking functions need a slot, and a full day has none.';
revoke all on function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid) from public;
grant execute on function api.guest_join_waitlist(text, uuid, date, time, time, text, text, text, uuid) to anon, authenticated, service_role;

-- redefines api.guest_claim_offer from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_claim_offer(p_token text, p_idempotency_key uuid) returns api.booking_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  w app.slot_waitlist;
  a app.appointments;
begin
  select * into w from app.slot_waitlist where token_hash = private.token_hash(p_token);
  if w.id is null then raise exception 'not_found'; end if;
  perform private.lock_location(w.location_id);
  select * into w from app.slot_waitlist where id = w.id for update;
  if w.status = 'expired' then raise exception 'offer_expired'; end if;
  if w.status not in ('offered', 'claimed') then raise exception 'not_found'; end if;
  select * into a from app.appointments where id = w.appointment_id for update;
  if w.status = 'offered' then
    if w.offer_expires_at <= now() then raise exception 'offer_expired'; end if;
    if a.status::text <> 'offered' then raise exception 'slot_taken'; end if;
    perform private.set_actor('guest', null, 'claim_offer');
    update app.appointments set status = 'booked' where id = a.id returning * into a;
    update app.slot_waitlist set status = 'claimed' where id = w.id;
  end if;
  return row(p_token, a.starts_at, a.ends_at, (select s.name from app.services s where s.id = a.service_id),
             (select l.name from app.locations l where l.id = a.location_id), a.status::text)::api.booking_result;
end $$;
comment on function api.guest_claim_offer(text, uuid) is
  'Claims the freed slot held for the waitlist token: the held appointment becomes booked, with no new capacity taken. '
  'Claiming again returns the same booking. Raises not_found (unknown token or nothing offered), offer_expired and '
  'slot_taken (the hold was lost). The idempotency key is accepted for symmetry; repeating is already a no-op.';

-- redefines api.guest_leave_waitlist from 20261030162713_api_contracts_2b.sql
create or replace function api.guest_leave_waitlist(p_token text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  w app.slot_waitlist;
  a app.appointments;
begin
  select * into w from app.slot_waitlist where token_hash = private.token_hash(p_token);
  if w.id is null then return; end if;
  perform private.lock_location(w.location_id);
  select * into w from app.slot_waitlist where id = w.id for update;
  if w.status not in ('waiting', 'offered') then return; end if;
  update app.slot_waitlist set status = 'cancelled' where id = w.id;
  if w.appointment_id is not null then
    perform private.set_actor('guest', null, 'leave_waitlist');
    update app.appointments set status = 'cancelled', cancelled_reason = 'waitlist_left'
    where id = w.appointment_id and status::text = 'offered' returning * into a;
    if a.id is not null then perform private.release_capacity(a); end if; -- the next guest is offered it
  end if;
end $$;
comment on function api.guest_leave_waitlist(text) is
  'Leaves the slot waitlist. An open offer is released at once and passes to the next guest. Leaving twice, or with an '
  'unknown token, is a no-op.';

create function ops.waitlist_tick() returns int
language plpgsql volatile set search_path = '' as $$
declare
  w app.slot_waitlist;
  a app.appointments;
  n int := 0;
begin
  perform private.set_actor('system', null, 'waitlist_tick');
  -- Location lock first, then the row, like claim and leave (the reverse order could deadlock with a claim).
  for w in select x.* from app.slot_waitlist x where x.status = 'offered' and x.offer_expires_at <= now()
           order by x.offer_expires_at
  loop
    perform private.lock_location(w.location_id);
    select x.* into w from app.slot_waitlist x
    where x.id = w.id and x.status = 'offered' and x.offer_expires_at <= now() for update;
    if w.id is null then continue; end if;
    update app.slot_waitlist set status = 'expired' where id = w.id;
    update app.appointments set status = 'cancelled', cancelled_reason = 'offer_expired'
    where id = w.appointment_id and status::text = 'offered' returning * into a;
    if a.id is not null then perform private.release_capacity(a); end if; -- offers it to the next guest
    n := n + 1;
  end loop;
  update app.slot_waitlist set status = 'expired' where status = 'waiting' and wanted_day < current_date - 1;
  return n;
end $$;
comment on function ops.waitlist_tick() is
  'Expires offers past their hold (the slot passes to the next waiting guest) and waiting entries whose day is over. '
  'Run every minute by pg_cron; returns how many offers expired.';
revoke all on function ops.waitlist_tick() from public, anon, authenticated;
select cron.schedule('waitlist-tick', '* * * * *', 'select ops.waitlist_tick()');
