-- #513: the staff read path for visits after #496's column grants. A whole-row reference needs
-- SELECT on every column, so the computed column app.allowed_actions(app.visits) no longer works
-- for staff. app.staff_visits is the replacement: the staff-visible columns plus allowed_actions.
--
-- In app, not api: anon has no USAGE on app (I-4 holds without relying on grants), and PostgREST
-- embeds services(...) and counters(...) only within one schema.
-- security_invoker: RLS on app.visits and the column grants apply to the caller.
-- supabase/tests/structure/staff_visits.test.sql fails when the view drifts from the grant.

create view app.staff_visits with (security_invoker = true) as
select
  v.id, v.org_id, v.location_id, v.queue_id, v.service_id, v.service_day,
  v.ticket_prefix, v.ticket_number, v.display_ticket, v.status, v.sort_key,
  v.party_size, v.guest_name, v.guest_id, v.contact_id, v.locale, v.source,
  v.counter_id, v.assigned_staff_id, v.call_count, v.eta_quoted_low, v.eta_quoted_high,
  v.joined_at, v.called_at, v.serving_at, v.finished_at, v.version,
  v.guest_phone_e164, v.guest_email,
  private.allowed_actions(v.status) as allowed_actions
from app.visits v;
comment on view app.staff_visits is
  'Visits as staff see them: RLS limits rows to locations where the caller is staff, and only the '
  'columns granted on app.visits appear. allowed_actions lists the staff actions legal from the '
  'visit''s status (the only source for console buttons). Read-only.';

revoke all on app.staff_visits from authenticated;
grant select on app.staff_visits to authenticated;

-- notifications.recipient_hash is an unsalted sha256 of the guest's canonical address, kept for
-- the dispatcher's per-inbox counts across orgs (#479). Staff have no use for it. As on visits,
-- a column added later is hidden until a migration grants it here.
revoke select on app.notifications from authenticated;
grant select (
  id, org_id, visit_id, event_id, channel, recipient_ref, template_key, template_version,
  category, vars, dedupe_key, consent_id, status, attempts, next_attempt_at, locked_until,
  provider, provider_message_id, error_code, segments, cost_micros, quiet_hours_deferred,
  created_at, updated_at
) on app.notifications to authenticated;
