-- 2A-GST3 (#124): what the status page needs for "I'm on my way", "I need more time" and the
-- arrive-by warning, and what the console needs for its "On the way" badge.
--
-- Alternatives rejected: (1) a second guest RPC for the snooze state: a new anon entry point for four
-- fields the status call already assembles; (2) the client working out remaining snoozes or the
-- warning moment from queue settings: it would re-derive rules the database owns. The status type
-- gains attributes (additive, like location_public before it); no signature changes.

alter type api.visit_status
  add attribute grace_until timestamptz,
  add attribute warn_at timestamptz,
  add attribute snoozes_left int,
  add attribute on_the_way boolean;

/**
 * Whether a visit's guest has said they are on the way for its current call and has not since been
 * put back in line. Staff badge and guest status read the same answer. Takes the columns, not the
 * row: the invoker view cannot pass app.visits whole (staff may not read every column).
 */
create function private.visit_on_the_way(p_visit_id uuid, p_status api.visit_state, p_call_count int)
returns boolean
language sql stable set search_path = '' as $$
  select p_status in ('waiting', 'called') and exists (
    select 1 from app.visit_events e
    where e.visit_id = p_visit_id and e.type = 'on_my_way'
      and (e.payload ->> 'call_count')::int = p_call_count
      and not exists (select 1 from app.visit_events r
                      where r.visit_id = p_visit_id and r.id > e.id and r.type in ('snoozed', 'requeue'))
  )
$$;
comment on function private.visit_on_the_way(uuid, api.visit_state, int) is
  'True while a waiting or called visit has an on_my_way event for its current call_count that no later snooze or requeue undid.';
revoke all on function private.visit_on_the_way(uuid, api.visit_state, int) from public, anon, authenticated;
-- The staff view below runs it as the caller (security_invoker).
grant execute on function private.visit_on_the_way(uuid, api.visit_state, int) to authenticated;

-- redefines private.visit_status from 20261025001800_guest_rpcs.sql
create or replace function private.visit_status(p_visit app.visits) returns api.visit_status
language sql stable set search_path = '' as $$
  select p_visit.display_ticket, p_visit.status, pos.n, pos.n - 1,
         e.eta_state, e.eta_low, e.eta_high,
         case when p_visit.status in ('called', 'serving') then c.label end,
         p_visit.call_count, p_visit.called_at, q.name, l.name, q.pulse_id,
         case when q.max_snoozes = 0
              then array_remove(private.guest_actions(p_visit.status), 'need_more_time'::api.guest_action)
              else private.guest_actions(p_visit.status) end,
         p_visit.version, now(),
         case when p_visit.status = 'called' then p_visit.grace_until end,
         case when p_visit.status = 'called' and p_visit.grace_until is not null
              then p_visit.grace_until - make_interval(secs => q.no_show_warning_seconds) end,
         case when p_visit.status in ('waiting', 'called') then greatest(q.max_snoozes - p_visit.snooze_count, 0) end,
         private.visit_on_the_way(p_visit.id, p_visit.status, p_visit.call_count)
  from app.queues q
  join app.locations l on l.id = q.location_id
  left join app.counters c on c.id = p_visit.counter_id
  cross join lateral (select private.visit_position(p_visit) as n) pos
  cross join lateral private.visit_eta(p_visit.id) e
  where q.id = p_visit.queue_id
$$;
comment on function private.visit_status(app.visits) is
  'The api.visit_status a guest sees for p_visit: no guest name, contact or other guests. The '
  'counter label only while called or serving; position and ETA only while waiting. While called: '
  'grace_until (arrive by) and warn_at (when to start warning); while waiting or called: '
  'snoozes_left; need_more_time is not offered when the queue allows no snoozes; on_the_way is '
  'true after on_my_way for the current call.';

-- redefines app.staff_visits from 20261030113001_staff_visits_arrival.sql
create or replace view app.staff_visits with (security_invoker = true) as
select
  v.id, v.org_id, v.location_id, v.queue_id, v.service_id, v.service_day,
  v.ticket_prefix, v.ticket_number, v.display_ticket, v.status, v.sort_key,
  v.party_size, v.guest_name, v.guest_id, v.contact_id, v.locale, v.source,
  v.counter_id, v.assigned_staff_id, v.call_count, v.eta_quoted_low, v.eta_quoted_high,
  v.joined_at, v.called_at, v.serving_at, v.finished_at, v.version,
  v.guest_phone_e164, v.guest_email,
  private.allowed_actions(v.status) as allowed_actions,
  v.assigned_counter_id,
  v.group_key,
  v.notes,
  v.tags,
  v.scheduled_at,
  v.scheduled_at - make_interval(mins => (select q.early_checkin_minutes from app.queues q where q.id = v.queue_id))
    as arrival_early_until,
  v.scheduled_at + make_interval(mins => (select q.late_tolerance_minutes from app.queues q where q.id = v.queue_id))
    as arrival_late_after,
  private.visit_on_the_way(v.id, v.status, v.call_count) as on_the_way
from app.visits v;
