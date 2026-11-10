-- 2P-APT12 (#168): every booked appointment has exactly one `expected` visit on its service day, so
-- the unified list, event log, pulse and display need no second engine (ADR 0010).
--
-- Triggers own the sync so no caller can forget it (booking, reschedule, cancel, guest leave):
--   * app.appointments BEFORE INSERT/UPDATE: materializes today's booking, moves or cancels the
--     visit when the booking moves or is cancelled.
--   * app.visits AFTER UPDATE (appointment visits only): the appointment follows the visit.
-- A 5-minute tick materializes tomorrow's bookings at the day boundary and marks unarrived
-- guests no_show after the queue's grace (actor system). The guest's appointment link doubles as the
-- visit link, so the same token checks in once the visit exists.

alter table app.queues
  add column no_show_after_minutes int not null default 15 check (no_show_after_minutes between 0 and 240);
create index appointments_visit_idx on app.appointments (visit_id) where visit_id is not null;

/** The visit for p_a, expected, scheduled at its start. Not exposed; restores the caller's actor context. */
create function private.materialize_appointment(p_a app.appointments) returns uuid
language plpgsql volatile set search_path = '' as $$
declare
  q app.queues;
  v_prefix text;
  v_number int;
  v_day date := private.service_day(p_a.location_id, p_a.starts_at);
  v_id uuid := gen_random_uuid();
  v_hash bytea;
  v_sort bigint;
  saved text[] := array[current_setting('app.actor_kind', true), current_setting('app.actor_id', true),
                        current_setting('app.action', true), current_setting('app.reason', true),
                        current_setting('app.event_payload', true)];
begin
  select * into q from app.queues where id = p_a.queue_id;
  select coalesce(s.ticket_prefix, q.ticket_prefix) into v_prefix from app.services s where s.id = p_a.service_id;
  v_prefix := coalesce(v_prefix, q.ticket_prefix);
  v_number := private.next_ticket(q.id, v_prefix, v_day);
  select coalesce(max(v.sort_key), 0) + 1024 into v_sort from app.visits v
  where v.queue_id = q.id and v.status in ('waiting', 'called');
  -- The appointment link opens the visit too, once; a re-materialized visit gets its own hash.
  v_hash := case when p_a.guest_token_hash is not null
                      and not exists (select 1 from app.visits x where x.guest_token_hash = p_a.guest_token_hash)
                 then p_a.guest_token_hash
                 else private.token_hash(gen_random_uuid()::text || gen_random_uuid()::text) end;
  perform private.set_actor('system', null, null, 'appointment');
  insert into app.visits (id, org_id, location_id, queue_id, service_id, service_day, ticket_prefix, ticket_number,
                          display_ticket, status, sort_key, guest_name, guest_id, contact_id, guest_phone_e164,
                          guest_email, locale, guest_token_hash, source, idempotency_key, scheduled_at)
  values (v_id, p_a.org_id, p_a.location_id, p_a.queue_id, p_a.service_id, v_day, v_prefix, v_number,
          v_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0'), 'expected', v_sort,
          p_a.guest_name, p_a.guest_id, p_a.contact_id, p_a.guest_phone_e164, p_a.guest_email,
          coalesce(p_a.locale, 'en'), v_hash, 'appointment', gen_random_uuid(), p_a.starts_at);
  perform set_config('app.actor_kind', coalesce(saved[1], ''), true), set_config('app.actor_id', coalesce(saved[2], ''), true),
          set_config('app.action', coalesce(saved[3], ''), true), set_config('app.reason', coalesce(saved[4], ''), true),
          set_config('app.event_payload', coalesce(saved[5], '{}'), true);
  return v_id;
end $$;
comment on function private.materialize_appointment(app.appointments) is
  'Creates the expected visit for an appointment (ticket numbered now, no place in line until check-in, '
  'source appointment, scheduled_at = starts_at) and returns its id. Not exposed.';

/** Runs one visit update as p_action with the caller's actor, then restores the action. */
create function private.visit_update_as(p_action text, p_visit_id uuid, p_expected boolean, p_set_status api.visit_state,
                                        p_skip_appointment boolean default false, p_scheduled_at timestamptz default null) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_old text := current_setting('app.action', true);
  v_queue uuid;
begin
  perform set_config('app.action', p_action, true), set_config('app.skip_appointment_sync', case when p_skip_appointment then '1' else '' end, true);
  update app.visits set status = coalesce(p_set_status, status),
         finished_at = case when p_set_status is not null then now() else finished_at end,
         scheduled_at = coalesce(p_scheduled_at, scheduled_at)
  where id = p_visit_id and (not p_expected or status = 'expected')
  returning queue_id into v_queue;
  perform set_config('app.action', coalesce(v_old, ''), true), set_config('app.skip_appointment_sync', '', true);
  if v_queue is not null then perform private.bump_queue_version(v_queue); end if;
end $$;
revoke all on function private.visit_update_as(text, uuid, boolean, api.visit_state, boolean, timestamptz) from public, anon, authenticated;

create function private.sync_appointment_visit() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_today boolean := private.service_day(new.location_id, new.starts_at) = private.service_day(new.location_id);
begin
  if tg_op = 'UPDATE' and old.visit_id is not null then
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      perform private.visit_update_as('cancel', old.visit_id, true, 'cancelled', true);
    elsif new.status = 'booked' and new.starts_at is distinct from old.starts_at then
      if private.service_day(new.location_id, new.starts_at) = private.service_day(old.location_id, old.starts_at) then
        perform private.visit_update_as('rescheduled', old.visit_id, true, null, true, new.starts_at);
      else
        perform private.visit_update_as('cancel', old.visit_id, true, 'cancelled', true);
        new.visit_id := null;
      end if;
    end if;
  end if;
  if new.status = 'booked' and new.visit_id is null and v_today then
    new.visit_id := private.materialize_appointment(new);
  end if;
  return new;
end $$;
create trigger sync_appointment_visit before insert or update on app.appointments
  for each row execute function private.sync_appointment_visit();

create function private.sync_visit_appointment() returns trigger
language plpgsql set search_path = '' as $$
declare
  a app.appointments;
  v_to app.appointment_status := case
    when old.status = 'expected' and new.status = 'waiting' then 'checked_in'
    when new.status = 'no_show' then 'no_show'
    when new.status = 'served' then 'completed'
    when old.status = 'expected' and new.status = 'expired' then 'no_show'
    when old.status = 'expected' and new.status = 'cancelled' then 'cancelled'
  end;
begin
  if v_to is null or current_setting('app.skip_appointment_sync', true) = '1' then return null; end if;
  update app.appointments set status = v_to
  where visit_id = new.id and status in ('booked', 'checked_in') and status <> v_to
  returning * into a;
  -- A guest or staff leaving the expected visit gives the seat back, as cancelling the booking does.
  if a.id is not null and v_to = 'cancelled' then perform private.release_capacity(a); end if;
  return null;
end $$;
create trigger sync_visit_appointment after update of status on app.visits
  for each row when (new.source = 'appointment' and old.status is distinct from new.status)
  execute function private.sync_visit_appointment();

/** Expected visits for the appointments whose service day at p_at is current. Returns how many. */
create function private.materialize_due(p_at timestamptz) returns int
language plpgsql volatile set search_path = '' as $$
declare
  a app.appointments;
  n int := 0;
begin
  for a in
    select x.* from app.appointments x
    where x.status = 'booked' and x.visit_id is null
      and x.starts_at between p_at - interval '2 days' and p_at + interval '2 days'
      and private.service_day(x.location_id, x.starts_at) = private.service_day(x.location_id, p_at)
    order by x.starts_at limit 1000 for update skip locked
  loop
    perform private.set_actor('system', null, null, 'day_start');
    update app.appointments set visit_id = private.materialize_appointment(a) where id = a.id;
    perform private.bump_queue_version(a.queue_id);
    n := n + 1;
  end loop;
  return n;
end $$;

/** Expected visits whose guest has not arrived no_show_after_minutes after the start. Returns how many. */
create function private.expire_unarrived(p_at timestamptz) returns int
language plpgsql volatile set search_path = '' as $$
declare
  ids uuid[];
begin
  -- Queue rows first, the order guest_act uses, so the tick and a check-in cannot deadlock.
  perform 1 from app.queues q where q.id in (
    select v.queue_id from app.visits v join app.queues q2 on q2.id = v.queue_id
    where v.status = 'expected' and v.scheduled_at is not null
      and v.scheduled_at + make_interval(mins => q2.no_show_after_minutes) < p_at)
  order by q.id for update;
  select coalesce(array_agg(v.id), '{}') into ids from (
    select v.id from app.visits v join app.queues q on q.id = v.queue_id
    where v.status = 'expected' and v.scheduled_at is not null
      and v.scheduled_at + make_interval(mins => q.no_show_after_minutes) < p_at
    order by v.scheduled_at limit 1000 for update of v skip locked) v;
  perform private.set_actor('system', null, 'no_show', 'grace_expired');
  perform private.visit_update_as('no_show', i, true, 'no_show') from unnest(ids) i;
  return cardinality(ids);
end $$;

create function ops.materialize_appointments() returns int
language sql volatile set search_path = '' as $$
  select private.materialize_due(now()) + private.expire_unarrived(now())
$$;
comment on function ops.materialize_appointments() is
  'Creates the expected visit of every booked appointment whose service day has begun and marks expected '
  'guests who did not arrive within the queue''s no_show_after_minutes as no_show (actor system). Idempotent. '
  'Run every 5 minutes by pg_cron; returns how many visits it created or closed.';
revoke all on function private.materialize_due(timestamptz), private.expire_unarrived(timestamptz),
  private.materialize_appointment(app.appointments), ops.materialize_appointments() from public, anon, authenticated;
select cron.schedule('materialize-appointments', '*/5 * * * *', 'select ops.materialize_appointments()');

-- An expected visit is never messaged, so it must not win "earliest live visit with this address".
-- redefines private.enqueue_notification from 20261030073601_queue_broadcast.sql
create or replace function private.enqueue_notification(
  p_visit app.visits,
  p_event_id bigint,
  p_trigger text,
  p_scope text,
  p_vars jsonb default '{}'
) returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, event_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_visit.org_id, p_visit.id, p_event_id, r.channel, r.ref, p_trigger, t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object('ticket', p_visit.display_ticket, 'counter', c.label)
                           || coalesce(p_vars, '{}')),
         concat_ws(':', p_scope, r.channel, r.ref)
  from (
    select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_visit.contact_id and gc.org_id = p_visit.org_id
    union all
    -- Online and kiosk joins keep what the guest typed on the visit (join_hardening); the visit
    -- itself is the recipient, so recipient_ref is the visit id. The address is unverified, so
    -- only the org's earliest live visit with it is mailed: repeated joins with someone else's
    -- address (or +tag and dot variants of it, canonical_email) send one visit's messages, not one
    -- per join.
    select ch.channel, p_visit.id
    from (values ('email'::app.notification_channel, p_visit.guest_email),
                 ('sms'::app.notification_channel, p_visit.guest_phone_e164)) ch (channel, value)
    where p_visit.contact_id is null and ch.value is not null
      -- Free text from staff never goes to an address a guest only typed (nobody verified it).
      and p_trigger <> 'broadcast'
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('waiting', 'called', 'serving')
          and case ch.channel when 'email' then private.canonical_email(o.guest_email)
                              else o.guest_phone_e164 end
              = case ch.channel when 'email' then private.canonical_email(ch.value) else ch.value end
          and (o.joined_at, o.id) < (p_visit.joined_at, p_visit.id))
  ) r
  cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                              r.channel, p_visit.locale) t
  left join app.counters c on c.id = p_visit.counter_id
  -- The guest's alert choice: a trigger they switched off is never queued.
  where p_trigger = any (private.visit_alert_triggers(p_visit.id))
  on conflict (dedupe_key) do nothing
$$;
