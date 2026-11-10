-- 2P-APT14 (#170): the console's Expected section labels each guest early, on time or late from
-- thresholds the database computes (queue knobs of ADR 0010), so no rule is re-derived in the client.

-- redefines app.staff_visits from 20261030085100_check_in.sql
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
  -- The console labels an expected guest early, on time or late by comparing these to the clock.
  v.scheduled_at - make_interval(mins => (select q.early_checkin_minutes from app.queues q where q.id = v.queue_id))
    as arrival_early_until,
  v.scheduled_at + make_interval(mins => (select q.late_tolerance_minutes from app.queues q where q.id = v.queue_id))
    as arrival_late_after
from app.visits v;
