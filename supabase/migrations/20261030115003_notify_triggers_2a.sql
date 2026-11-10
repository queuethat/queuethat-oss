-- 2A-NT1 (#132): the remaining guest notification triggers, chosen per queue by the owner.
--
-- joined (you're in line), no_show_warning (your place will be given away), removed and served are
-- queued in the transaction of the event that causes them, like called and almost_up. Two layers
-- decide whether a guest gets one: the queue's notify_triggers (what the owner offers) and the
-- guest's own choice (alert_preferences) which can only narrow it; a guest with no saved choice
-- gets everything the queue offers. Position and estimate updates already coalesce
-- (2P-NTF3, renotify): one per renotify_min_interval_seconds, measured from the last message told.
--
-- Alternative rejected: a second pg_cron sweep (position_tick) for position_changed. The event
-- spine plus ops.renotify_sweep already evaluate it, so a second job would double-message.
--
-- redefines private.template_variables from 20261030080001_inbound_messages.sql
-- redefines private.enqueue_for_event from 20261030073001_renotify.sql
-- redefines private.visit_alert_triggers from 20261030073601_queue_broadcast.sql
-- redefines api.outbox_still_relevant from 20261030100001_appointment_reminders.sql

alter table app.queues
  add column notify_triggers text[] not null default '{called,almost_up,position_changed,eta_changed}'
  check (notify_triggers <@ array['joined', 'called', 'almost_up', 'position_changed', 'eta_changed',
                                  'no_show_warning', 'removed', 'served']);
comment on column app.queues.notify_triggers is
  'The alerts this queue offers its guests. A guest can switch any of them off but cannot switch on one the queue does not offer. Announcements (broadcast) are not governed by this list. The default keeps the phase 1 alerts and the position and estimate updates.';

-- Guests can choose among every trigger the queue can offer.
alter table app.alert_preferences drop constraint alert_preferences_triggers_check;
alter table app.alert_preferences add constraint alert_preferences_triggers_check
  check (triggers <@ array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast',
                           'removed', 'served', 'joined', 'no_show_warning']);

-- redefines private.alert_trigger_names from 20261030061418_alert_preferences.sql
create or replace function private.alert_trigger_names() returns text[]
language sql immutable set search_path = '' as $$
  select array['called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed', 'served',
               'joined', 'no_show_warning']
$$;

-- redefines private.visit_alert_triggers from 20261030073601_queue_broadcast.sql
create or replace function private.visit_alert_triggers(p_visit_id uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce((
    select array(
      select n from unnest(private.alert_trigger_names()) n
      where n = any (coalesce(p.triggers, q.notify_triggers || array['broadcast']))
        and (n = 'broadcast' or n = any (q.notify_triggers))
    )
    from app.visits v
    join app.queues q on q.id = v.queue_id
    left join app.alert_preferences p on p.visit_id = v.id
    where v.id = p_visit_id
  ), '{}')
$$;
comment on function private.visit_alert_triggers(uuid) is
  'The triggers the visit''s guest receives: their saved choice, else everything the queue offers (queues.notify_triggers) and announcements; never one the queue does not offer. Announcements are the venue''s own and not governed by the queue list.';

-- redefines private.visit_alert_available from 20261030061418_alert_preferences.sql
create or replace function private.visit_alert_available(p_visit app.visits) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(n order by array_position(private.alert_trigger_names(), n)), '{}')
  from unnest(private.alert_trigger_names()) n
  where exists (
    select 1 from app.notification_templates t
    where t.trigger = n and (t.org_id is null or t.org_id = p_visit.org_id)
      and (t.queue_id is null or t.queue_id = p_visit.queue_id))
    and (n = 'broadcast'
         or exists (select 1 from app.queues q where q.id = p_visit.queue_id and n = any (q.notify_triggers)))
$$;
comment on function private.visit_alert_available(app.visits) is
  'The alert triggers that have a message template for the visit and that its queue offers, in display order.';

------------------------------------------------------------------------------------------------
-- Templates
------------------------------------------------------------------------------------------------

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning'));

create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger = 'help' then array[]::text[]
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served',
                       'joined', 'no_show_warning') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

-- Default English wording for push, email and the console; SMS has no template yet (phase 3).
insert into app.notification_templates (trigger, channel, subject, body)
select t.trigger, c.channel, case when c.channel = 'email' then t.subject end, t.body || c.suffix
from (values
  ('joined', 'You''re in line',
   'You''re in line at {{location_name}}: ticket {{ticket}}, number {{position}}. Follow your place: {status_link}'),
  ('no_show_warning', 'Your place is about to be given away',
   'Your place ({{ticket}}) will be given away in a minute unless you arrive or ask for more time: {status_link}'),
  ('removed', 'You were removed from the line',
   'Ticket {{ticket}} was removed from the line at {{location_name}}. Please ask the staff if this is a surprise.'),
  ('served', 'Thanks for visiting',
   'Thanks for visiting {{location_name}} (ticket {{ticket}}).')
) t (trigger, subject, body)
cross join (values
  ('push'::app.notification_channel, ''),
  ('console'::app.notification_channel, ''),
  ('email'::app.notification_channel,
   E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]')
) c (channel, suffix);

------------------------------------------------------------------------------------------------
-- Enqueue
------------------------------------------------------------------------------------------------

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

  -- The guest's own messages. enqueue_notification checks the queue's list and the guest's choice.
  if new.type = 'joined' then
    -- A booked guest (expected) has no place yet.
    if v.status = 'waiting' then
      perform private.enqueue_notification(v, new.id, 'joined', 'joined:' || v.id,
                                           jsonb_build_object('position', private.visit_position(v)));
    end if;
  elsif new.type = 'no_show_warning' then
    perform private.enqueue_notification(v, new.id, 'no_show_warning', 'no_show_warning:' || new.id);
    return null;
  elsif new.type = 'remove' then
    perform private.enqueue_notification(v, new.id, 'removed', 'removed:' || v.id);
  elsif new.type = 'complete' then
    perform private.enqueue_notification(v, new.id, 'served', 'served:' || v.id);
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
  'AFTER INSERT on app.visit_events: queues `called` for call and recall, `joined` for a join, `no_show_warning` for the system warning, `removed` and `served` when staff remove or complete the visit, and `almost_up` for waiting visits now within the queue''s threshold, in the event''s transaction. Each is skipped unless the queue offers it and the guest has not switched it off. Visits that move out of range and back are not messaged twice. A join records the joiner''s baseline place and estimate; any other event then evaluates position and estimate updates (private.evaluate_renotify).';

------------------------------------------------------------------------------------------------
-- Relevance
------------------------------------------------------------------------------------------------

create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
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
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed or eta_changed once the guest is no longer waiting, called and no_show_warning after the guest moved on or was called again (called also after an undo), removed and served unless the staff undid them, a joined message for a finished visit, an appointment message whose booking changed, or an unknown id. Account mail is always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173), re-notify in 2P-NTF3 (#175), the remaining triggers in 2A-NT1 (#132).';
