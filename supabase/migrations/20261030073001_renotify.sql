-- 2P-NTF3 (#175): tell a waiting guest when their place or estimate changes materially.
--
-- Evaluated in the transaction of every queue event (bounded to 500 waiting visits) and by a
-- one-minute sweep for drift with time. app.visit_notify_state holds what each guest was last
-- told, so thresholds measure against the last message, not the last event: three small moves
-- that add up still cross. At most one message per evaluation (eta_changed before
-- position_changed), at most one per renotify_min_interval_seconds, and only for guests whose
-- alert preferences include the trigger (2P-NTF1).
--
-- Alternative rejected: a trigger on visit sort_key. It would fire once per row of a bulk
-- reorder and miss ETA drift; the event spine already fires once per change.

alter table app.queues
  add column renotify_eta_delta_minutes int not null default 10 check (renotify_eta_delta_minutes between 1 and 240),
  add column renotify_position_delta int not null default 3 check (renotify_position_delta between 1 and 100),
  add column renotify_min_interval_seconds int not null default 300 check (renotify_min_interval_seconds between 30 and 86400);
comment on column app.queues.renotify_eta_delta_minutes is
  'A waiting guest is told when the middle of their estimate moves this many minutes from what they were last told.';
comment on column app.queues.renotify_position_delta is
  'A waiting guest is told when their place in line moves this many places from what they were last told.';
comment on column app.queues.renotify_min_interval_seconds is
  'No guest gets two position or estimate updates closer together than this.';

create table app.visit_notify_state (
  org_id uuid not null,
  visit_id uuid primary key,
  last_eta_low int,
  last_eta_high int,
  last_position int,
  last_notified_at timestamptz,
  foreign key (org_id, visit_id) references app.visits (org_id, id)
);
comment on table app.visit_notify_state is
  'What a waiting guest was last told about their place and estimate (the join counts), for '
  'private.evaluate_renotify. Written only by that function.';
create trigger forbid_org_change before update on app.visit_notify_state
  for each row execute function private.forbid_org_change();
revoke insert, update, delete, truncate on app.visit_notify_state from authenticated;
alter table app.visit_notify_state enable row level security;
create policy visit_notify_state_select on app.visit_notify_state for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));

------------------------------------------------------------------------------------------------
-- Default alerts: position and estimate updates are on (N-9)
------------------------------------------------------------------------------------------------

-- 2P-NTF1 defaulted to called and almost_up only, which would leave this feature off for every
-- guest who never opens the alerts sheet. Push and email updates are free and limited to one per
-- five minutes; SMS has no template yet. Guests who already chose keep their choice.
alter table app.alert_preferences
  alter column triggers set default '{called,almost_up,position_changed,eta_changed}';

-- redefines private.visit_alert_triggers from 20261030061418_alert_preferences.sql
create or replace function private.visit_alert_triggers(p_visit_id uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce((select p.triggers from app.alert_preferences p where p.visit_id = p_visit_id),
                  '{called,almost_up,position_changed,eta_changed}')
$$;
comment on function private.visit_alert_triggers(uuid) is
  'The triggers the visit''s guest receives: their saved choice, else called, almost_up and the '
  'position and estimate updates.';

------------------------------------------------------------------------------------------------
-- Templates: position joins the editable variables; default wording for both triggers
------------------------------------------------------------------------------------------------

-- redefines private.template_variables from 20261030062359_template_versions.sql
create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

-- position_up/position_back and eta_sooner/eta_later hold the same value; only one of each pair is
-- set, so the optional [segment] for the other direction disappears.
insert into app.notification_templates (trigger, channel, subject, body)
select t.trigger, c.channel, case when c.channel = 'email' then t.subject end, t.body || c.suffix
from (values
  ('position_changed', 'Your place in line changed',
   '[You moved up, {{ticket}}: you''re now number {{position_up}} in line.][Your place changed, {{ticket}}: you''re now number {{position_back}} in line.]'),
  ('eta_changed', 'Your wait changed',
   '[Good news, {{ticket}}: your wait is now about {{eta_sooner}}.][Update for {{ticket}}: your wait is now about {{eta_later}}.]')
) t (trigger, subject, body)
cross join (values
  ('push'::app.notification_channel, ''),
  ('console'::app.notification_channel, ''),
  ('email'::app.notification_channel,
   E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]')
) c (channel, suffix);

------------------------------------------------------------------------------------------------
-- Enqueue takes extra variables
------------------------------------------------------------------------------------------------

drop function private.enqueue_notification(app.visits, bigint, text, text);

-- redefines private.enqueue_notification from 20261030061418_alert_preferences.sql
create function private.enqueue_notification(
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
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('expected', 'waiting', 'called', 'serving')
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
comment on function private.enqueue_notification(app.visits, bigint, text, text, jsonb) is
  'Queues p_trigger for every recipient of the visit that has a template: push subscriptions, and '
  'the visit''s contact, or without one the email and phone typed at join (recipient_ref = visit '
  'id) unless an earlier live visit in the org has the same address. Nothing is queued when the '
  'guest''s alert preferences leave p_trigger out. Snapshots the template version and '
  '{ticket, counter} plus p_vars (no contact data). Idempotent per (p_scope, channel, recipient).';
revoke all on function private.enqueue_notification(app.visits, bigint, text, text, jsonb)
  from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Evaluation
------------------------------------------------------------------------------------------------

/** Records what a guest was just told (or, at join, shown) without sending anything. */
create function private.init_notify_state(p_visit_id uuid) returns void
language sql volatile set search_path = '' as $$
  insert into app.visit_notify_state (org_id, visit_id, last_eta_low, last_eta_high, last_position)
  select v.org_id, v.id, e.eta_low, e.eta_high, private.visit_position(v)
  from app.visits v
  cross join lateral private.visit_eta(v.id) e
  where v.id = p_visit_id and v.status = 'waiting'
  on conflict (visit_id) do nothing
$$;
comment on function private.init_notify_state(uuid) is
  'Baseline for private.evaluate_renotify: the place and estimate a waiting visit starts with.';

/**
 * Sends position_changed or eta_changed to waiting guests of p_queue_id whose place or estimate
 * moved past the queue's thresholds since they were last told. Returns how many it evaluated as
 * due. A visit with no baseline gets one and no message.
 */
create function private.evaluate_renotify(p_queue_id uuid, p_event_id bigint default null) returns int
language plpgsql volatile set search_path = '' as $$
declare
  q app.queues;
  r record;
  st app.visit_notify_state;
  e record;
  w app.visits;
  prefs text[];
  trig text;
  mid_now numeric;
  mid_then numeric;
  wants_eta boolean;
  wants_pos boolean;
  vars jsonb;
  sent int := 0;
  scope text := coalesce('e' || p_event_id, 'm' || to_char(now(), 'YYYYMMDDHH24MI'));
begin
  select * into q from app.queues where id = p_queue_id;
  if not found then
    return 0;
  end if;
  for r in
    select x.id, x.pos from (
      select v.id, row_number() over (order by v.sort_key, v.id)::int as pos
      from app.visits v
      where v.queue_id = p_queue_id and v.service_day = private.service_day(q.location_id)
        and v.status = 'waiting'
    ) x
    order by x.pos limit 500
  loop
    -- Locked, so an event racing the sweep (or another event) waits and then sees the new baseline.
    select * into st from app.visit_notify_state where visit_id = r.id for update;
    if not found then
      perform private.init_notify_state(r.id);
      continue;
    end if;
    if st.last_notified_at is not null
       and now() < st.last_notified_at + make_interval(secs => q.renotify_min_interval_seconds) then
      continue;
    end if;
    prefs := private.visit_alert_triggers(r.id);
    -- Cheap tests first: the estimate is only computed for a guest who could be messaged by it.
    wants_eta := 'eta_changed' = any (prefs);
    wants_pos := 'position_changed' = any (prefs)
                 and st.last_position is not null
                 and abs(r.pos - st.last_position) >= q.renotify_position_delta;
    if not wants_eta and not wants_pos then
      continue;
    end if;
    select * into e from private.visit_eta(r.id);
    mid_now := (e.eta_low + e.eta_high) / 2.0;
    mid_then := (st.last_eta_low + st.last_eta_high) / 2.0;
    trig := case
      when mid_now is not null and mid_then is not null
           and abs(mid_now - mid_then) >= q.renotify_eta_delta_minutes
           and wants_eta then 'eta_changed'
      when wants_pos then 'position_changed'
    end;
    if trig is null then
      continue;
    end if;
    select * into w from app.visits where id = r.id;
    vars := jsonb_build_object('position', r.pos,
                               'eta_range', case when e.eta_low is not null then e.eta_low || '–' || e.eta_high || ' min' end)
         || case when r.pos < st.last_position then jsonb_build_object('position_up', r.pos)
                 else jsonb_build_object('position_back', r.pos) end
         || case when e.eta_low is null then '{}'::jsonb
                 when mid_now < mid_then then jsonb_build_object('eta_sooner', e.eta_low || '–' || e.eta_high || ' min')
                 else jsonb_build_object('eta_later', e.eta_low || '–' || e.eta_high || ' min') end;
    perform private.enqueue_notification(w, p_event_id, trig,
                                         'renotify:' || trig || ':' || r.id || ':' || scope, vars);
    update app.visit_notify_state
    set last_eta_low = e.eta_low, last_eta_high = e.eta_high, last_position = r.pos, last_notified_at = now()
    where visit_id = r.id;
    sent := sent + 1;
  end loop;
  return sent;
end $$;
comment on function private.evaluate_renotify(uuid, bigint) is
  'Queues eta_changed (preferred) or position_changed for waiting guests of the queue whose estimate '
  'moved by renotify_eta_delta_minutes or place by renotify_position_delta since they were last told, '
  'at most one per renotify_min_interval_seconds and only if their alert preferences include it. '
  'Looks at the first 500 waiting visits. Returns how many guests were messaged.';

create function ops.renotify_sweep() returns int
language plpgsql volatile set search_path = '' as $$
declare
  q record;
  total int := 0;
begin
  for q in select distinct v.queue_id from app.visits v where v.status = 'waiting' loop
    total := total + private.evaluate_renotify(q.queue_id);
  end loop;
  return total;
end $$;
comment on function ops.renotify_sweep() is
  'Runs private.evaluate_renotify for every queue with waiting guests, to catch estimates that '
  'drift with time. Run every minute by pg_cron; returns how many guests were messaged.';
select cron.schedule('renotify-sweep', '* * * * *', 'select ops.renotify_sweep()');

------------------------------------------------------------------------------------------------
-- Event trigger and relevance
------------------------------------------------------------------------------------------------

-- redefines private.enqueue_for_event from 20261025002000_enqueue_notifications.sql
create or replace function private.enqueue_for_event() returns trigger
language plpgsql set search_path = '' as $$
declare
  v app.visits;
  w app.visits;
  threshold int;
begin
  select * into v from app.visits where id = new.visit_id;

  if new.type in ('call', 'recall') then
    perform private.enqueue_notification(v, new.id, 'called', 'e' || new.id);
  end if;

  -- A join only pushes others back and the joiner just saw its place; rollover ends the day.
  if new.type in ('joined', 'expire') then
    if new.type = 'joined' then
      perform private.init_notify_state(v.id);
    end if;
    return null;
  end if;

  select q.almost_up_threshold into threshold from app.queues q where q.id = v.queue_id;
  for w in
    select * from app.visits x
    where x.queue_id = v.queue_id and x.service_day = v.service_day and x.status = 'waiting'
    order by x.sort_key, x.id
    limit threshold
  loop
    perform private.enqueue_notification(w, new.id, 'almost_up', 'almost_up:' || w.id);
  end loop;

  perform private.evaluate_renotify(v.queue_id, new.id);
  return null;
end $$;
comment on function private.enqueue_for_event() is
  'AFTER INSERT on app.visit_events: queues `called` for call and recall events and `almost_up` '
  'for waiting visits now within the queue''s threshold, in the event''s transaction. Visits '
  'that move out of range and back are not messaged twice. A join records the joiner''s baseline '
  'place and estimate; any other event then evaluates position and estimate updates '
  '(private.evaluate_renotify).';

-- redefines api.outbox_still_relevant from 20261030061418_alert_preferences.sql
create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l
                        where l.visit_id = v.id and l.id > n.event_id and l.type in ('call', 'recall'))
      when n.template_key in ('almost_up', 'position_changed', 'eta_changed') then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed '
  'or eta_changed once the guest is no longer waiting, called after the call was undone, superseded by '
  'a newer call or the guest moved on, anything for a finished visit or an unknown id. Account mail '
  'is always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173), re-notify in '
  '2P-NTF3 (#175).';

revoke all on function private.init_notify_state(uuid), private.evaluate_renotify(uuid, bigint),
  ops.renotify_sweep() from public, anon, authenticated;
