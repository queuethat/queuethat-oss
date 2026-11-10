-- S5 (#26): every phase 1 api.* RPC with its final signature and return type.
--
-- Bodies raise not_implemented; the visit engine tickets (V1-V10, N3, N4) replace them with
-- `create or replace` and must not change a signature or a return type. A signature change goes
-- back to the single owner as its own PR that regenerates packages/db-types.
--
-- Each function's COMMENT is its interface documentation: what it guarantees and which errors it
-- raises (as the exception message, errcode P0001 unless noted). Read those before the bodies.

------------------------------------------------------------------------------------------------
-- Enums
------------------------------------------------------------------------------------------------

-- Guest self-service actions. Later phases append values (on_my_way, need_more_time, check_in)
-- rather than adding guest_* functions.
create type api.guest_action as enum ('leave');

-- Owned by private.visit_eta (V5). Clients format these; they never derive them.
create type api.eta_state as enum ('hidden', 'paused', 'unstaffed', 'next', 'over_hour', 'ok');

grant usage on type api.guest_action, api.eta_state to anon, authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Return types
------------------------------------------------------------------------------------------------

create type api.public_service as (
  id uuid,
  name text,
  description text
);

create type api.public_queue as (
  id uuid,
  name text,
  state api.queue_state,
  -- The single accepting predicate (manual state, hours, capacity). False -> show why, never a form.
  accepting boolean,
  not_accepting_reason text, -- 'paused' | 'closed' | 'outside_hours' | 'full' | null
  waiting_count int,
  eta_state api.eta_state,
  eta_low int,
  eta_high int,
  -- Public realtime topic qpulse:{pulse_id} for live open/closed changes on the join page.
  pulse_id uuid,
  services api.public_service[]
);

create type api.location_public as (
  id uuid,
  name text,
  slug text,
  tz text,
  address text,
  contact text,
  queues api.public_queue[]
);

create type api.join_result as (
  -- The plaintext link token, returned exactly once. Only its sha256 is stored.
  token text,
  display_ticket text,
  status api.visit_state
);

create type api.visit_status as (
  display_ticket text,
  status api.visit_state,
  -- 1 = next to be called. Null once the visit is no longer waiting.
  position int,
  people_ahead int,
  eta_state api.eta_state,
  eta_low int,
  eta_high int,
  counter_label text,
  call_count int,
  called_at timestamptz,
  queue_name text,
  location_name text,
  queue_pulse_id uuid,
  guest_actions api.guest_action[],
  version int,
  -- Server time of this snapshot. Clients show "as of" from this, never from their own clock.
  as_of timestamptz
);

create type api.visit_row as (
  id uuid,
  queue_id uuid,
  service_id uuid,
  service_name text,
  display_ticket text,
  status api.visit_state,
  sort_key bigint,
  position int,
  party_size int,
  guest_name text,
  source text,
  counter_id uuid,
  counter_label text,
  call_count int,
  joined_at timestamptz,
  called_at timestamptz,
  serving_at timestamptz,
  finished_at timestamptz,
  eta_quoted_low int,
  eta_quoted_high int,
  version int,
  -- What staff may do next, from app.visit_transitions. Render buttons from this.
  allowed_actions api.visit_action[],
  -- The event this call wrote, for the undo toast.
  last_event_id bigint
);

create type api.queue_row as (
  id uuid,
  location_id uuid,
  name text,
  ticket_prefix text,
  manual_state api.queue_state,
  accepting boolean,
  not_accepting_reason text,
  servers_on_duty int,
  capacity int,
  waiting_count int,
  version bigint
);

create type api.today_stats as (
  location_id uuid,
  service_day date,
  waiting_now int,
  served int,
  no_shows int,
  cancelled int,
  avg_wait_minutes numeric,
  as_of timestamptz
);

create type api.display_ticket as (
  display_ticket text,
  counter_label text,
  -- Only when locations.display_names_enabled; otherwise always null.
  first_name text,
  called_at timestamptz
);

create type api.display_queue as (
  id uuid,
  name text,
  state api.queue_state,
  now_serving api.display_ticket[],
  next_up api.display_ticket[]
);

create type api.display_snapshot as (
  location_id uuid,
  location_name text,
  names_enabled boolean,
  queues api.display_queue[],
  as_of timestamptz
);

-- One claimed outbox row with everything the dispatcher needs to send it. Service role only.
create type api.outbox_job as (
  id uuid,
  org_id uuid,
  visit_id uuid,
  channel app.notification_channel,
  category app.message_category,
  template_key text,
  template_version int,
  locale text,
  subject text,
  body text,
  vars jsonb,
  -- {"kind":"push","endpoint","p256dh","auth"} or {"kind":"address","value"}
  recipient jsonb,
  has_consent boolean,
  is_suppressed boolean,
  location_tz text,
  attempts int,
  status_url text
);

grant usage on type api.public_service, api.public_queue, api.location_public, api.join_result,
  api.visit_status to anon, authenticated, service_role;
grant usage on type api.visit_row, api.queue_row, api.today_stats, api.display_ticket,
  api.display_queue, api.display_snapshot to authenticated, service_role;
grant usage on type api.outbox_job to service_role;

------------------------------------------------------------------------------------------------
-- The state machine as data: allowed actions per visit (implemented, not a stub)
------------------------------------------------------------------------------------------------

create function private.allowed_actions(p_status api.visit_state) returns api.visit_action[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(t.action order by t.action), '{}')
  from app.visit_transitions t
  where t.from_status = p_status
    -- system-only actions are not offered to staff
    and t.action not in ('expire')
$$;
comment on function private.allowed_actions(api.visit_state) is
  'Staff actions legal from p_status according to app.visit_transitions (system-only actions '
  'such as expire excluded). The only source for buttons in the console.';

create function private.guest_actions(p_status api.visit_state) returns api.guest_action[]
language sql immutable set search_path = '' as $$
  select case when p_status in ('waiting', 'called') then array['leave']::api.guest_action[]
              else '{}'::api.guest_action[] end
$$;
comment on function private.guest_actions(api.visit_state) is
  'Guest actions available in p_status. Clients show a Leave button only when this contains leave.';

-- PostgREST computed column: GET /visits?select=*,allowed_actions
create function app.allowed_actions(v app.visits) returns api.visit_action[]
language sql stable set search_path = '' as $$
  select private.allowed_actions(v.status)
$$;
comment on function app.allowed_actions(app.visits) is
  'Computed column for staff reading app.visits directly: the actions legal from this visit''s status.';

grant execute on function private.allowed_actions(api.visit_state) to authenticated, service_role;
grant execute on function private.guest_actions(api.visit_state) to authenticated, service_role;
grant execute on function app.allowed_actions(app.visits) to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Guest functions (anon). Exactly these five; adding one needs a security-review PR.
------------------------------------------------------------------------------------------------

create function api.get_location_public(p_location_slug text) returns api.location_public
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.get_location_public(text) is
  'Public view of a location by its slug (or a redirected old slug): name, contact, and each '
  'non-archived queue with its accepting state, waiting count, ETA and active services. Contains '
  'no guest data. Raises not_found for an unknown slug. Implemented in V6 (#35).';

create function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key): repeating a call returns '
  'the same visit, with a fresh token only on the first call and null afterwards. Client values '
  'for priority, status, org or ticket are never accepted. Raises queue_not_accepting (paused, '
  'closed or outside hours), capacity_reached, rate_limited, not_found (unknown queue or '
  'service), invalid_input (bad name, phone, email or party size). Later phases append '
  'parameters with defaults; never add join_* variants. Implemented in V1 (#30).';

create function api.get_visit_status(p_token text) returns api.visit_status
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.get_visit_status(text) is
  'The guest''s own visit: ticket, status, position, ETA triple, counter when called, pulse '
  'topic, available guest actions and server as_of time. Never includes contact data or other '
  'guests. Unknown tokens and tokens expired 12 hours after the visit ended raise the same '
  'not_found. Implemented in V6 (#35).';

create function api.guest_act(p_token text, p_action api.guest_action, p_idempotency_key uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_act(text, api.guest_action, uuid) is
  'Applies a guest action to the token''s visit and returns the new status. leave moves waiting or '
  'called to cancelled; leaving again returns cancelled without error. Raises not_found as '
  'get_visit_status does, illegal_transition when the action no longer applies (e.g. already '
  'served). New guest actions are new api.guest_action values. Implemented in V6 (#35).';

create function api.guest_register_push(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_register_push(text, text, text, text) is
  'Stores a Web Push subscription for the token''s visit. Repeating it with the same endpoint '
  'changes nothing. Raises not_found as get_visit_status does, invalid_input for a non-https '
  'endpoint. Implemented in N4 (#70).';

------------------------------------------------------------------------------------------------
-- Staff functions (members of the visit's location; role checked inside)
------------------------------------------------------------------------------------------------

create function api.staff_add_visit(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_party_size int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_add_visit(uuid, uuid, text, text, int, uuid) is
  'Adds a walk-in on the guest''s behalf (source staff). Same rules as join_queue, including the '
  'accepting predicate (Q-17 applies to every entry point), through the same private.join_core. '
  'Idempotent per (queue, key). Raises queue_not_accepting, capacity_reached, not_found (also for '
  'a queue the caller is not staff of), invalid_input. Implemented in V4 (#33).';

create function api.call_next(p_queue_id uuid, p_counter_id uuid, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.call_next(uuid, uuid, uuid) is
  'Calls the first waiting visit by sort_key to p_counter_id and returns it, or null when nobody '
  'is waiting. Concurrent callers always get different visits; repeating a key returns the same '
  'visit. Raises not_found for a queue or counter outside the caller''s locations. Implemented '
  'in V2 (#31).';

create function api.transition_visit(
  p_visit_id uuid,
  p_action api.visit_action,
  p_expected_version int,
  p_idempotency_key uuid,
  p_counter_id uuid default null,
  p_reason text default null
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.transition_visit(uuid, api.visit_action, int, uuid, uuid, text) is
  'Applies one staff action (call, recall, start, requeue, complete, no_show, cancel, remove, '
  'reinstate) and returns the updated row. Repeating a key returns the first result. Raises '
  'stale_visit when p_expected_version is not current (refetch and retry), illegal_transition, '
  'invalid_input when remove has no reason, not_found for a visit outside the caller''s locations '
  '(no existence leak). Implemented in V2 (#31).';

create function api.undo_event(p_event_id bigint, p_idempotency_key uuid) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.undo_event(bigint, uuid) is
  'Reverses a visit event by writing a compensating undo event and restoring the previous status '
  'and position. Allowed only for the visit''s latest event, within 10 minutes. Repeating a key '
  'returns the first result. Raises undo_not_allowed, not_found. Implemented in V3 (#32).';

create function api.set_queue_state(p_queue_id uuid, p_state api.queue_state) returns api.queue_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_queue_state(uuid, api.queue_state) is
  'Opens, pauses or closes a queue for every entry point at once and returns it. Pausing keeps '
  'waiting guests; closing stops joins. Setting the current state again changes nothing. Raises '
  'not_found for a queue outside the caller''s locations. Implemented in V4 (#33).';

create function api.today_stats(p_location_id uuid) returns api.today_stats
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.today_stats(uuid) is
  'Counts for the location''s current service day: waiting now, served, no-shows, cancelled, '
  'average wait. Staff of the location only; raises not_found otherwise. Implemented in V10 (#39).';

create function api.display_snapshot(p_location_id uuid) returns api.display_snapshot
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.display_snapshot(uuid) is
  'What the waiting-room TV shows: per queue, now serving (ticket and counter) and the next '
  'tickets. First names only when the location enabled them. Callable by staff and paired '
  'devices of that location; raises not_found for anyone else. Implemented in V10 (#39).';

------------------------------------------------------------------------------------------------
-- Dispatcher functions (service role only)
------------------------------------------------------------------------------------------------

create function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.claim_outbox(int, int) is
  'Leases up to p_limit due notifications for p_lease_seconds and returns them with recipient, '
  'template and policy inputs resolved. Concurrent dispatchers never receive the same row. '
  'Implemented in N3 (#69).';

create function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: almost_up after the guest was called, called after the '
  'call was undone, anything for a visit already finished. Implemented in N2/N3 (#68, #69).';

create function api.report_outbox_result(p_outbox_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros}; failures back off and the sixth becomes dead. '
  'Implemented in N3 (#69).';

------------------------------------------------------------------------------------------------
-- Jobs (pg_cron only, not exposed)
------------------------------------------------------------------------------------------------

create function ops.rollover_tick() returns int
language plpgsql volatile set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function ops.rollover_tick() is
  'Expires leftover visits for every location whose service day has changed since its last '
  'rollover, and returns how many visits it changed. Idempotent; safe to run late or twice. '
  'Implemented in V7 (#36).';

------------------------------------------------------------------------------------------------
-- Grants (technical-design.md 5)
------------------------------------------------------------------------------------------------

revoke all on all functions in schema api from public, anon, authenticated, service_role;

grant execute on function
  api.get_location_public(text),
  api.join_queue(uuid, uuid, text, text, text, int, text, uuid),
  api.get_visit_status(text),
  api.guest_act(text, api.guest_action, uuid),
  api.guest_register_push(text, text, text, text)
to anon, authenticated, service_role;

grant execute on function
  api.create_organization(text, text, text),
  api.staff_add_visit(uuid, uuid, text, text, int, uuid),
  api.call_next(uuid, uuid, uuid),
  api.transition_visit(uuid, api.visit_action, int, uuid, uuid, text),
  api.undo_event(bigint, uuid),
  api.set_queue_state(uuid, api.queue_state),
  api.today_stats(uuid),
  api.display_snapshot(uuid)
to authenticated;

grant execute on function
  api.claim_outbox(int, int),
  api.outbox_still_relevant(uuid),
  api.report_outbox_result(uuid, jsonb)
to service_role;
