-- #496: staff read app.visits through a column grant, not a table grant. RLS still decides
-- which rows; this decides which columns. Left out:
--   idempotency_key   with the device key it replays a join and returns the guest's link token
--   guest_token_hash  and device_key_hash: would let staff correlate guests and devices
-- Postgres gives a new column no privileges when the table has only column grants, so a column
-- added later is hidden from API roles until a migration grants it here.
-- supabase/tests/structure/visit_columns.test.sql fails until every column is classified.
-- service_role keeps its table grant (Edge Functions, e2e fixtures).

revoke select on app.visits from authenticated;
grant select (
  id, org_id, location_id, queue_id, service_id, service_day,
  ticket_prefix, ticket_number, display_ticket, status, sort_key,
  party_size, guest_name, guest_id, contact_id, locale, source,
  counter_id, assigned_staff_id, call_count, eta_quoted_low, eta_quoted_high,
  joined_at, called_at, serving_at, finished_at, version,
  guest_phone_e164, guest_email
) on app.visits to authenticated;

-- Cost: Postgres checks a whole-row reference against every column, so staff can no longer call
-- the PostgREST computed column app.allowed_actions(app.visits) (unused so far). Nothing reads it
-- today; the staff RPCs return allowed_actions in api.visit_row. A per-row list that needs
-- actions (C3, #60) gets them from a read that selects only granted columns.
-- 20261025004800_join_device_key.sql says staff can read idempotency keys; that is no longer true.
comment on function app.allowed_actions(app.visits) is
  'Computed column: the actions legal from this visit''s status. Callable by service_role only: '
  'signed-in callers have column grants on app.visits, and a whole-row argument needs them all.';
