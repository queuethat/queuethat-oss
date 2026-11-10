-- 2B-A3 (#278): group and class events with seat capacity.
-- An event seat booking is an appointment row linked to the event, so check-in, reminders, no-show and
-- materialization reuse the appointment logic. `seats` (the party size) consumes event capacity, not slot
-- capacity: events never touch appointment_slot_counts. The event row is the lock; app.events.booked is
-- maintained only by definer functions (guard_event) and given back by private.release_capacity, which every
-- cancel path already calls.
--
-- Alternative rejected: counting seats with a sum() over appointments at booking time. It needs the same lock
-- and makes every booking O(bookings); a locked counter is O(1) and the check constraint is the backstop.
-- Event create/edit uses RLS-gated writes (manager+) with guard_event as the integrity rule, so no new RPC.
--
-- redefines private.release_capacity from 20261030071001_book_appointment.sql
-- redefines api.outbox_still_relevant from 20261030115003_notify_triggers_2a.sql

create type app.event_status as enum ('scheduled', 'cancelled');
grant usage on type app.event_status to anon, authenticated, service_role;

create table app.events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 120),
  during tstzrange not null check (not isempty(during) and lower_inc(during) and not upper_inf(during) and not lower_inf(during)),
  capacity int not null check (capacity between 1 and 1000),
  booked int not null default 0,
  status app.event_status not null default 'scheduled',
  public boolean not null default false,
  created_at timestamptz not null default now(),
  check (booked between 0 and capacity),
  foreign key (org_id, location_id, service_id) references app.services (org_id, location_id, id),
  unique (org_id, id)
);
create index events_location_idx on app.events (location_id, (lower(during)));

alter table app.appointments
  add column event_id uuid,
  add column seats int not null default 1 check (seats between 1 and 100),
  add constraint appointments_event_fk foreign key (org_id, event_id) references app.events (org_id, id),
  add constraint appointments_event_seats check (event_id is not null or seats = 1);
create index appointments_event_idx on app.appointments (event_id) where event_id is not null;

create function private.guard_event() returns trigger
language plpgsql set search_path = '' as $$
declare via_api boolean := nullif(current_setting('app.actor_kind', true), '') is not null;
begin
  if tg_op = 'INSERT' then
    new.booked := 0;
    new.status := 'scheduled';
    return new;
  end if;
  if new.org_id is distinct from old.org_id or new.id is distinct from old.id then
    raise exception 'immutable_column' using errcode = '42501';
  end if;
  if not via_api and (new.booked is distinct from old.booked or new.status is distinct from old.status) then
    raise exception 'immutable_column' using errcode = '42501', hint = 'Seats and status change only through api.* functions.';
  end if;
  if old.booked > 0 and (new.during is distinct from old.during or new.service_id is distinct from old.service_id
                         or new.location_id is distinct from old.location_id) then
    raise exception 'event_has_bookings';
  end if;
  return new;
end $$;
create trigger guard_event before insert or update on app.events
  for each row execute function private.guard_event();
create trigger audit_row after insert or update of title, during, capacity, public, service_id, status or delete on app.events
  for each row execute function private.audit_row();

alter table app.events enable row level security;
create policy events_select on app.events for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy events_insert on app.events for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy events_update on app.events for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
grant select, insert, update on app.events to authenticated;
grant all on app.events to service_role;

-- Event bookings never held slot capacity; they give their seats back to the event instead.
create or replace function private.release_capacity(p_appointment app.appointments) returns void
language sql volatile set search_path = '' as $$
  update app.events set booked = greatest(booked - p_appointment.seats, 0)
  where id = p_appointment.event_id;
  update app.appointment_slot_counts set count = greatest(count - 1, 0)
  where p_appointment.event_id is null and service_id = p_appointment.service_id and slot_start = p_appointment.starts_at;
  update app.appointment_day_counts set count = greatest(count - 1, 0)
  where p_appointment.event_id is null and service_id = p_appointment.service_id and local_date = p_appointment.local_date;
$$;

-- A booked event seat keeps its time: the event is the only thing that moves it.
create function private.guard_event_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.event_id is distinct from old.event_id or new.seats is distinct from old.seats then
    raise exception 'immutable_column' using errcode = '42501';
  end if;
  if new.event_id is not null and new.starts_at is distinct from old.starts_at then
    raise exception 'event_booking_fixed';
  end if;
  return new;
end $$;
create trigger guard_event_booking before update on app.appointments
  for each row execute function private.guard_event_booking();

-- Notifications: event_cancelled reaches the same recipients as appointment reminders.
alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled'));
insert into app.notification_templates (trigger, channel, subject, body)
select 'event_cancelled', c.channel, case when c.channel = 'email' then 'Event cancelled' end,
       'Cancelled: {{event_title}} at {{location_name}}, {{appointment_time}}. Your booking is cancelled.' || c.suffix
from (values ('push'::app.notification_channel, ''), ('console'::app.notification_channel, ''),
             ('sms'::app.notification_channel, ''),
             ('email'::app.notification_channel, E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]')) c (channel, suffix);

-- Queues one message about an appointment to web push, the consented linked contact and the email typed at booking.
create function private.enqueue_appointment_notification(p_a app.appointments, p_trigger text, p_vars jsonb)
returns void language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, appointment_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key)
  select p_a.org_id, p_a.id, x.channel, x.ref, p_trigger, t.version, t.category,
         jsonb_build_object('appointment_time', to_char(p_a.starts_at at time zone l.tz, 'FMDay FMDD FMMonth, HH24:MI'),
                            'location_name', l.name, 'starts_epoch', floor(extract(epoch from p_a.starts_at))::bigint) || p_vars,
         format('appt:%s:%s:%s:%s', p_a.id, p_trigger, x.channel, x.ref)
  from app.locations l
  cross join lateral (
    select 'push'::app.notification_channel as channel, ps.id as ref
    from app.push_subscriptions ps where ps.appointment_id = p_a.id
    union all
    select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_a.contact_id and gc.org_id = p_a.org_id
      and coalesce((select c.status = 'granted' and c.revoked_at is null from app.consents c
                    where c.contact_id = gc.id and c.channel = case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel
                      and c.purpose = 'transactional'
                    order by c.captured_at desc limit 1), false)
    union all
    select 'email'::app.notification_channel, p_a.id where p_a.contact_id is null and p_a.guest_email is not null
  ) x
  cross join lateral private.resolve_template(p_a.org_id, p_a.queue_id, p_trigger, x.channel, p_a.locale) t
  where l.id = p_a.location_id
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_appointment_notification(app.appointments, text, jsonb) is
  'Queues p_trigger about an appointment for web push, the consented linked contact and the email typed at booking '
  '(a typed phone is never texted). Idempotent per (appointment, trigger, recipient). p_vars must carry no contact data.';
revoke all on function private.enqueue_appointment_notification(app.appointments, text, jsonb) from public, anon, authenticated;

create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- A cancelled event's message is about the cancellation; it stands while the booking is cancelled.
      when n.appointment_id is not null and n.template_key = 'event_cancelled' then ap.status = 'cancelled'
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
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed or eta_changed once the guest is no longer waiting, called and no_show_warning after the guest moved on or was called again (called also after an undo), removed and served unless the staff undid them, a joined message for a finished visit, an appointment message whose booking changed (an event_cancelled message instead needs the booking cancelled), or an unknown id. Account mail is always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173), re-notify in 2P-NTF3 (#175), the remaining triggers in 2A-NT1 (#132), events in 2B-A3 (#278).';

create function private.event_row(p_e app.events) returns api.event_row
language sql immutable set search_path = '' as $$
  select row(p_e.id, p_e.location_id, p_e.title, lower(p_e.during), upper(p_e.during), p_e.capacity, p_e.booked,
             p_e.status::text)::api.event_row
$$;
revoke all on function private.event_row(app.events) from public, anon, authenticated;

-- redefines api.book_event_seats from 20261030162713_api_contracts_2b.sql
create or replace function api.book_event_seats(p_event_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size int, p_idempotency_key uuid)
returns api.booking_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.events;
  l app.locations;
  s app.services;
  a app.appointments;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone_e164, ''), '[[:space:]().-]', '', 'g'), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_seats int := coalesce(p_party_size, 1);
  v_id uuid := gen_random_uuid();
begin
  select * into e from app.events where id = p_event_id;
  if e.id is null or not e.public or e.status <> 'scheduled' or upper(e.during) <= now() then raise exception 'not_found'; end if;
  select * into l from app.locations where id = e.location_id;
  select * into s from app.services where id = e.service_id;
  if p_idempotency_key is null or v_name is null or length(v_name) > 60 or v_name ~ '[[:cntrl:]]'
     or (v_phone is null and v_email is null)
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$')
     or (v_email is not null and (length(v_email) > 254
         or v_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$'))
     or v_seats not between 1 and 20 then
    raise exception 'invalid_input';
  end if;
  perform private.lock_location(l.id);
  -- A repeated key returns the earlier booking and takes no seats.
  select x.* into a from app.appointments x where x.location_id = l.id and x.idempotency_key = p_idempotency_key;
  if not found then
    select * into e from app.events where id = p_event_id for update;
    if e.status <> 'scheduled' then raise exception 'not_found'; end if;
    if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then
      raise exception 'org_suspended';
    end if;
    if private.is_blocked(l.org_id, v_phone, v_email) then raise exception 'rate_limited' using detail = 'client'; end if;
    if (select count(*) from app.appointments x
        where x.location_id = l.id and x.source = 'guest' and x.created_at > now() - interval '1 minute') >= l.booking_rate_per_min then
      raise exception 'rate_limited' using detail = 'network';
    end if;
    if e.booked + v_seats > e.capacity then raise exception 'event_full'; end if;
    perform private.set_actor('guest', null, null, null, jsonb_build_object('source', 'guest'));
    insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, guest_name,
                                  guest_phone_e164, guest_email, locale, guest_token_hash, source, idempotency_key, event_id, seats)
    values (v_id, l.org_id, l.id, s.id, s.queue_id, lower(e.during), upper(e.during), (lower(e.during) at time zone l.tz)::date,
            v_name, v_phone, v_email, (select o.default_locale from app.organizations o where o.id = l.org_id),
            private.token_hash(private.visit_token(v_id, p_idempotency_key)), 'guest', p_idempotency_key, e.id, v_seats)
    returning * into a;
    update app.events set booked = booked + v_seats where id = e.id;
  end if;
  if a.event_id is distinct from p_event_id then raise exception 'invalid_input'; end if;
  return row(private.visit_token(a.id, p_idempotency_key), a.starts_at, a.ends_at, e.title, l.name, a.status::text)::api.booking_result;
end $$;
comment on function api.book_event_seats(uuid, text, text, text, int, uuid) is
  'Anonymous booking of 1-20 seats in a public, scheduled, future event. Locks the event row; a booking that would '
  'exceed capacity raises event_full and takes nothing. Idempotent per (location, p_idempotency_key): a repeat returns '
  'the same booking and token and takes no seats. A phone (E.164) or an email is required. Raises not_found (unknown, '
  'private, cancelled or past event), invalid_input, org_suspended, rate_limited and event_full.';

-- redefines api.cancel_event from 20261030162713_api_contracts_2b.sql
create or replace function api.cancel_event(p_event_id uuid, p_reason text, p_idempotency_key uuid)
returns api.event_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.events;
  a app.appointments;
  v_reason text := left(nullif(btrim(p_reason), ''), 200);
begin
  select * into e from app.events where id = p_event_id;
  if e.id is null or not (select private.has_role(e.org_id, e.location_id, 'manager')) then raise exception 'not_found'; end if;
  perform private.lock_location(e.location_id);
  select * into e from app.events where id = p_event_id for update;
  if e.status = 'cancelled' then return private.event_row(e); end if;
  perform private.set_actor('staff', (select auth.uid()), 'cancel_event', v_reason);
  update app.events set status = 'cancelled' where id = e.id returning * into e;
  for a in select x.* from app.appointments x where x.event_id = e.id and x.status in ('booked', 'checked_in') order by x.created_at loop
    update app.appointments set status = 'cancelled', cancelled_reason = coalesce(v_reason, 'event_cancelled')
    where id = a.id returning * into a;
    perform private.release_capacity(a);
    perform private.enqueue_appointment_notification(a, 'event_cancelled', jsonb_build_object('event_title', e.title));
  end loop;
  select * into e from app.events where id = e.id;
  return private.event_row(e);
end $$;
comment on function api.cancel_event(uuid, text, uuid) is
  'Cancels an event and every booked or checked-in seat booking (state change with an appointment event, never a '
  'delete) and queues an event_cancelled message per recipient. Manager or above of the location. Repeating is a no-op '
  'that returns the cancelled event. Raises not_found (unknown, or another org).';
