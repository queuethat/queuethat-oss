-- 2B-API1: every phase 2b guest, staff, admin and service RPC with its final signature, so the
-- parallel phase 2b epics build against one set of types and db-types stays regenerable. Bodies
-- raise not_implemented; the owning ticket (named in each COMMENT) replaces its body with
-- `create or replace` and must not change a signature or a return type.
--
-- join_queue is extended, not duplicated (technical-design.md 3.5): it gains p_location_id
-- (2B-Q4 routing) and p_arrive_after (2B-J3 join for later), accepted and ignored until those
-- tickets land. Old bundles pass named arguments, so they keep working.
-- Not stubbed here: the api_v1 schema (owned end to end by the developer-platform epic, because it
-- needs a PostgREST config change) and ops.* tick functions (never called by another epic).
-- Reused types: api.visit_row, api.visit_status, api.membership_row and api.booking_result.

------------------------------------------------------------------------------------------------
-- Return types
------------------------------------------------------------------------------------------------

create type api.feedback_result as (
  submitted boolean,
  already_submitted boolean
);

create type api.chat_message as (
  id bigint,
  visit_id uuid,
  sender text,
  body text,
  created_at timestamptz,
  read_at timestamptz
);

create type api.link_code as (
  deep_link text,
  expires_at timestamptz
);

create type api.link_result as (
  linked boolean,
  visit_id uuid
);

create type api.notification_status as (
  id uuid,
  visit_id uuid,
  channel text,
  template text,
  status text,
  attempts int,
  last_error text,
  created_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz
);

create type api.counter_snapshot as (
  counter_label text,
  ticket text,
  status text,
  guest_first_name text,
  as_of timestamptz
);

create type api.location_overview as (
  location_id uuid,
  location_name text,
  queues_open int,
  waiting_count int,
  longest_wait_min int,
  eta_low int,
  eta_high int,
  as_of timestamptz
);

create type api.shift_row as (
  id uuid,
  location_id uuid,
  user_id uuid,
  counter_id uuid,
  service_day date,
  starts_at timestamptz,
  ends_at timestamptz,
  note text
);

create type api.presence_row as (
  user_id uuid,
  location_id uuid,
  status text,
  counter_id uuid,
  since timestamptz
);

create type api.event_row as (
  id uuid,
  location_id uuid,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity int,
  seats_taken int,
  status text
);

create type api.bulk_block_result as (
  block_ids uuid[],
  conflicts uuid[]
);

create type api.appointment_search_row as (
  id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  guest_name text,
  service_name text,
  staff_name text
);

create type api.eta_accuracy_row as (
  grp text,
  visits int,
  within_range_pct numeric,
  median_error_min numeric,
  bias_min numeric
);

create type api.performance_row as (
  grp_id uuid,
  label text,
  served int,
  avg_service_sec int,
  avg_wait_sec int,
  no_shows int
);

create type api.heatmap_cell as (
  dow int,
  hour int,
  avg_arrivals numeric,
  avg_wait_min numeric,
  suggested_staff int
);

create type api.location_metrics as (
  location_id uuid,
  location_name text,
  visits int,
  avg_wait_min numeric,
  avg_service_min numeric,
  no_show_pct numeric,
  within_eta_pct numeric
);

create type api.feedback_summary_row as (
  grp text,
  responses int,
  avg_rating numeric,
  nps numeric,
  promoters int,
  passives int,
  detractors int
);

create type api.feedback_comment_row as (
  id uuid,
  visit_id uuid,
  rating int,
  nps int,
  comment text,
  created_at timestamptz
);

create type api.duplicate_pair as (
  keep_id uuid,
  merge_id uuid,
  reason text,
  score numeric
);

create type api.guest_row as (
  id uuid,
  name text,
  contacts jsonb,
  tags text[],
  visit_count int,
  last_visit_at timestamptz
);

create type api.guest_export_row as (
  guest_id uuid,
  name text,
  phone_e164 text,
  email text,
  tags text[],
  notes text,
  visit_count int,
  last_visit_at timestamptz,
  consent jsonb
);

create type api.import_row_result as (
  row_no int,
  outcome text,
  guest_id uuid,
  error text
);

create type api.api_key_created as (
  key_id uuid,
  prefix text,
  plaintext_key text
);

create type api.api_key_row as (
  id uuid,
  org_id uuid,
  name text,
  prefix text,
  scopes text[],
  location_ids uuid[],
  created_at timestamptz,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create type api.webhook_endpoint_created as (
  id uuid,
  secret text
);

create type api.webhook_job as (
  delivery_id uuid,
  url text,
  kind text,
  event_type text,
  payload jsonb,
  secret text,
  attempt int
);

grant usage on type
  api.feedback_result,
  api.chat_message,
  api.link_code,
  api.link_result,
  api.notification_status,
  api.counter_snapshot,
  api.location_overview,
  api.shift_row,
  api.presence_row,
  api.event_row,
  api.bulk_block_result,
  api.appointment_search_row,
  api.eta_accuracy_row,
  api.performance_row,
  api.heatmap_cell,
  api.location_metrics,
  api.feedback_summary_row,
  api.feedback_comment_row,
  api.duplicate_pair,
  api.guest_row,
  api.guest_export_row,
  api.import_row_result,
  api.api_key_created,
  api.api_key_row,
  api.webhook_endpoint_created,
  api.webhook_job
to authenticated, service_role;
grant usage on type api.feedback_result, api.chat_message, api.link_code to anon;

------------------------------------------------------------------------------------------------
-- api.join_queue: appended defaulted parameters
------------------------------------------------------------------------------------------------

drop function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text);
-- redefines api.join_queue from 20261030110500_anon_join_switch.sql
create function api.join_queue(
  p_queue_id uuid,
  p_service_id uuid,
  p_name text,
  p_phone_e164 text,
  p_email text,
  p_party_size int,
  p_locale text,
  p_idempotency_key uuid,
  p_device_key text default null,
  p_join_pass text default null,
  p_answers jsonb default '{}'::jsonb,
  p_group_key uuid default null,
  p_onsite_code text default null,
  p_location_id uuid default null,
  p_arrive_after timestamptz default null
) returns api.join_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  joined record;
  result api.join_result;
begin
  if private.device_kind() = 'kiosk' then
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'kiosk', 'device', (select auth.uid()),
      null, p_answers, p_group_key, p_onsite_code);
  else
    -- 2A-JN4 (#114): once the deployment turned the direct path off, an anonymous caller has to
    -- come through the public-join Edge Function (service role), which checks the CAPTCHA and
    -- the per-IP limits first. A throwaway signed-up account is no better than anon, so every
    -- caller but the service role is refused here; kiosks took the branch above.
    if (select auth.role()) is distinct from 'service_role'
       and not (select s.anon_join_enabled from private.deployment_settings s) then
      raise exception 'captcha_required' using detail = 'public_join';
    end if;
    -- The public-join Edge Function (service role) has already verified the CAPTCHA with its own
    -- provider (2A-JN2); everyone else needs a Turnstile pass when the deployment has a site key.
    if (select auth.role()) is distinct from 'service_role' then
      perform private.spend_join_pass(p_join_pass, p_queue_id, p_idempotency_key);
    end if;
    select * into joined from private.join_core(p_queue_id, p_service_id, p_name, p_phone_e164,
      p_email, p_party_size, p_locale, p_idempotency_key, 'online', 'guest', null, p_device_key,
      p_answers, p_group_key, p_onsite_code);
  end if;

  select joined.token, v.display_ticket, v.status into result
  from app.visits v
  where v.id = joined.visit_id;
  return result;
end $$;

comment on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text, uuid, timestamptz) is
  'The one join interface for every source (anon guest, kiosk device; source is derived from the '
  'caller, never a parameter). Idempotent per (queue, p_idempotency_key), and per (queue, '
  'p_device_key) while that device''s visit is waiting, called or serving: a repeat returns the '
  'same visit and changes nothing, even once the queue has stopped accepting. The token comes back '
  'only to the device that joined (a replayed key needs the same p_device_key; kiosks get their '
  'own visits'' tokens), else null, as for visits older than the token secret. The token is '
  'base64url(HMAC-SHA256(Vault secret guest_token_secret, ''visit:'' || visit_id || '':'' || '
  'idempotency_key)), never stored or rotated; the visit keeps only its sha256. p_device_key is a random id the guest''s browser keeps (22 to 128 '
  'base64url characters); kiosks'' is ignored, since many guests share one. When the deployment '
  'has a Turnstile site key, an online join needs p_join_pass from api.issue_join_pass: unused '
  'and unexpired, or spent within the last day on this same queue and p_idempotency_key (a '
  'replay); a refused join '
  'leaves it unspent. Kiosks need none, and neither does the service role (the public-join Edge Function, which verifies its CAPTCHA before calling). Client values for '
  'priority, status, org or ticket are never accepted. Blank name, phone, email, locale or device '
  'key count as not given; party size defaults to 1. The phone and email are kept on the visit '
  'for its own messages and never linked to an existing guest. Raises captcha_required (online '
  'join without a valid pass, or DETAIL public_join: any caller but a kiosk or the service role while deployment_settings.anon_join_enabled is false), queue_not_accepting '
  '(paused, closed or outside hours; the reason is the DETAIL), org_suspended (the org is not '
  'active), capacity_reached, rate_limited (DETAIL client: this phone on this network; network: '
  'this network; queue: everyone, for a minute; queue_total: the queue''s online joins for the '
  'hour; device: this kiosk), not_found (unknown queue or '
  'service, or a kiosk of another location), invalid_input (bad name, phone, email, party size, '
  'locale or device key, or no key). p_answers (intake answers, 2A-Q5), p_group_key (join as '
  'a group, 2A-J15A) and p_onsite_code (the code on the display, 2A-JN5) are accepted and '
  'ignored until those tickets land; later they add party_size_out_of_range, invalid_answers, '
  'onsite_code_required, onsite_code_invalid, captcha_failed and too_many_active_visits. Later '
  'phases append parameters with defaults; never add join_* variants. Implemented in V1 (#30), '
  'device key in #474, join pass for Turnstile. p_location_id (route to a queue when p_queue_id is '
  'null, 2B-Q4) and p_arrive_after (join for later, 2B-J3) are accepted and ignored until those '
  'tickets land; later they add already_in_queue (2B-J1) and the routing and scheduling errors.';

revoke all on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text, uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function api.join_queue(uuid, uuid, text, text, text, int, text, uuid, text, text, jsonb, uuid, text, uuid, timestamptz)
  to anon, authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Stubs
------------------------------------------------------------------------------------------------

create function api.set_visit_priority(p_visit_id uuid, p_priority_class_id uuid, p_expected_version int, p_idempotency_key uuid) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_visit_priority(uuid, uuid, int, uuid) is
  'Sets or clears (null class) the visit''s priority class and re-places it by the class offset. '
  'Staff of the location; raises not_found, version_conflict, illegal_transition for terminal '
  'visits. Stub until 2B-Q3 (#228) replaces the body; the signature is fixed.';

create function api.advance_journey(p_visit_id uuid, p_expected_version int, p_idempotency_key uuid) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.advance_journey(uuid, int, uuid) is
  'Moves the visit to the next step of its journey (a transfer to the step''s queue). Staff of the '
  'location; a repeat or the last step is a no-op. Stub until 2B-Q8 (#233) replaces the body; the '
  'signature is fixed.';

create function api.guest_add_companion(p_token text, p_first_name text, p_idempotency_key uuid) returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_add_companion(text, text, uuid) is
  'Adds a named companion to the token''s party, within the queue''s party size bounds. Raises '
  'not_found, invalid_input, party_size_out_of_range. Stub until 2B-J5 (#243) replaces the body; '
  'the signature is fixed.';

create function api.guest_remove_companion(p_token text, p_companion_id uuid) returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_remove_companion(text, uuid) is
  'Removes a companion from the token''s party; removing twice is a no-op. Stub until 2B-J5 (#243) '
  'replaces the body; the signature is fixed.';

create function api.staff_set_companions(p_visit_id uuid, p_names text[], p_expected_version int, p_idempotency_key uuid) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_set_companions(uuid, text[], int, uuid) is
  'Replaces the visit''s companion names. Staff of the location. Stub until 2B-J5 (#243) replaces '
  'the body; the signature is fixed.';

create function api.guest_submit_feedback(p_token text, p_rating int, p_nps int, p_comment text, p_idempotency_key uuid) returns api.feedback_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_submit_feedback(text, int, int, text, uuid) is
  'Stores post-visit feedback for the token''s finished visit within 24 hours; a second submission '
  'returns already_submitted and changes nothing. Stub until 2B-G1 (#247) replaces the body; the '
  'signature is fixed.';

create function api.guest_send_message(p_token text, p_body text, p_idempotency_key uuid) returns api.chat_message
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_send_message(text, text, uuid) is
  'Sends a guest message on the token''s open visit. Rate limited; raises not_found, invalid_input, '
  'rate_limited. Stub until 2B-G3 (#249) replaces the body; the signature is fixed.';

create function api.guest_list_messages(p_token text, p_after_id bigint default 0) returns setof api.chat_message
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_list_messages(text, bigint) is
  'The token''s chat messages after p_after_id, oldest first. Never includes staff identities '
  'beyond a display name. Stub until 2B-G3 (#249) replaces the body; the signature is fixed.';

create function api.staff_send_message(p_visit_id uuid, p_body text, p_idempotency_key uuid) returns api.chat_message
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_send_message(uuid, text, uuid) is
  'Sends a staff message on a visit of the caller''s location. Stub until 2B-G3 (#249) replaces the '
  'body; the signature is fixed.';

create function api.staff_mark_read(p_visit_id uuid, p_up_to_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_mark_read(uuid, bigint) is
  'Marks guest messages up to p_up_to_id read. Stub until 2B-G3 (#249) replaces the body; the '
  'signature is fixed.';

create function api.guest_create_link_code(p_token text, p_channel text) returns api.link_code
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_create_link_code(text, text) is
  'Creates a short-lived single-use code and deep link that ties the token''s visit to a Telegram '
  'chat. Stub until 2B-N2 (#252) replaces the body; the signature is fixed.';

create function api.redeem_link_code(p_code text, p_chat_id text) returns api.link_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.redeem_link_code(text, text) is
  'Service role only (the Telegram webhook Edge Function): binds the chat to the visit once; a used '
  'or expired code returns linked = false. Stub until 2B-N2 (#252) replaces the body; the signature '
  'is fixed.';

create function api.list_visit_notifications(p_visit_id uuid) returns setof api.notification_status
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.list_visit_notifications(uuid) is
  'Outbox delivery status for one visit. Staff of the location. Stub until 2B-N6 (#256) replaces '
  'the body; the signature is fixed.';

create function api.list_failed_notifications(p_location_id uuid, p_since timestamptz) returns setof api.notification_status
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.list_failed_notifications(uuid, timestamptz) is
  'Failed or suppressed messages of a location since a time. Staff of the location. Stub until '
  '2B-N6 (#256) replaces the body; the signature is fixed.';

create function api.retry_notification(p_notification_id uuid, p_idempotency_key uuid) returns api.notification_status
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.retry_notification(uuid, uuid) is
  'Requeues a failed message once. Staff of the location; raises not_found, illegal_transition. '
  'Stub until 2B-N6 (#256) replaces the body; the signature is fixed.';

create function api.counter_display_snapshot() returns api.counter_snapshot
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.counter_display_snapshot() is
  'What a counter-scoped display device shows: its counter label, current ticket and state. Device '
  'claims only. Stub until 2B-D1 (#258) replaces the body; the signature is fixed.';

create function api.set_member_locations(p_membership_id uuid, p_location_ids uuid[], p_idempotency_key uuid) returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_member_locations(uuid, uuid[], uuid) is
  'Sets the locations a member works at (null = every location). Owner or admin. Stub until 2B-ORG1 '
  '(#265) replaces the body; the signature is fixed.';

create function api.org_overview(p_org_id uuid) returns setof api.location_overview
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.org_overview(uuid) is
  'One live summary row per location the caller can see. Stub until 2B-ORG3 (#267) replaces the '
  'body; the signature is fixed.';

create function api.list_shifts(p_location_id uuid, p_from_day date, p_to_day date) returns setof api.shift_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.list_shifts(uuid, date, date) is
  'Staff shifts of a location grouped by service day. Members of the location. Stub until 2B-ORG5 '
  '(#269) replaces the body; the signature is fixed.';

create function api.set_my_presence(p_location_id uuid, p_status text, p_counter_id uuid, p_idempotency_key uuid) returns api.presence_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_my_presence(uuid, text, uuid, uuid) is
  'Sets the caller''s presence (available, break, away) at a location; feeds the ETA''s server '
  'count. Stub until 2B-S1 (#271) replaces the body; the signature is fixed.';

create function api.guest_claim_offer(p_token text, p_idempotency_key uuid) returns api.booking_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_claim_offer(text, uuid) is
  'Claims an offered freed slot for the waitlist token. Raises not_found, slot_taken, '
  'offer_expired. (The ticket text names the return type appointment_result; it is '
  'api.booking_result.) Stub until 2B-A1 (#276) replaces the body; the signature is fixed.';

create function api.guest_leave_waitlist(p_token text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_leave_waitlist(text) is
  'Leaves the slot waitlist; leaving twice is a no-op. Stub until 2B-A1 (#276) replaces the body; '
  'the signature is fixed.';

create function api.book_event_seats(p_event_id uuid, p_name text, p_phone_e164 text, p_email text, p_party_size int, p_idempotency_key uuid) returns api.booking_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.book_event_seats(uuid, text, text, text, int, uuid) is
  'Books seats in a group or class event. Raises not_found, capacity_reached, invalid_input, '
  'rate_limited. Stub until 2B-A3 (#278) replaces the body; the signature is fixed.';

create function api.cancel_event(p_event_id uuid, p_reason text, p_idempotency_key uuid) returns api.event_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.cancel_event(uuid, text, uuid) is
  'Cancels an event and its bookings. Manager or above. Stub until 2B-A3 (#278) replaces the body; '
  'the signature is fixed.';

create function api.block_time_bulk(p_location_id uuid, p_resource_ids uuid[], p_ranges tstzrange[], p_reason text, p_idempotency_key uuid) returns api.bulk_block_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.block_time_bulk(uuid, uuid[], tstzrange[], text, uuid) is
  'Blocks time on resources; conflicting appointments are listed, not cancelled. Stub until 2B-A9 '
  '(#284) replaces the body; the signature is fixed.';

create function api.search_appointments(p_location_id uuid, p_query text, p_from date, p_to date, p_statuses text[], p_limit int default 25, p_after uuid default null) returns setof api.appointment_search_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.search_appointments(uuid, text, date, date, text[], int, uuid) is
  'Keyset-paged appointment search across future dates. Staff of the location. Stub until 2B-A12 '
  '(#287) replaces the body; the signature is fixed.';

create function api.eta_accuracy(p_location_id uuid, p_from_day date, p_to_day date, p_group text) returns setof api.eta_accuracy_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.eta_accuracy(uuid, date, date, text) is
  'How often the quoted ETA range held, grouped by hour, queue or service. Stub until 2B-W2 (#290) '
  'replaces the body; the signature is fixed.';

create function api.staff_performance(p_location_id uuid, p_from_day date, p_to_day date, p_by text) returns setof api.performance_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_performance(uuid, date, date, text) is
  'Served counts and times per staff member or counter. Manager or above. Stub until 2B-R1 (#292) '
  'replaces the body; the signature is fixed.';

create function api.peak_heatmap(p_location_id uuid, p_weeks int default 8, p_target_util numeric default 0.8) returns setof api.heatmap_cell
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.peak_heatmap(uuid, int, numeric) is
  'Arrivals and waits by weekday and hour with a suggested staff count. Stub until 2B-R3 (#294) '
  'replaces the body; the signature is fixed.';

create function api.location_comparison(p_org_id uuid, p_from_day date, p_to_day date) returns setof api.location_metrics
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.location_comparison(uuid, date, date) is
  'The same metrics for every location of the org. Owner or admin. Stub until 2B-R5 (#296) replaces '
  'the body; the signature is fixed.';

create function api.feedback_summary(p_location_id uuid, p_from_day date, p_to_day date, p_group text) returns setof api.feedback_summary_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.feedback_summary(uuid, date, date, text) is
  'Rating and NPS aggregates. Manager or above. Stub until 2B-R7 (#298) replaces the body; the '
  'signature is fixed.';

create function api.feedback_comments(p_location_id uuid, p_from_day date, p_to_day date, p_limit int, p_after uuid) returns setof api.feedback_comment_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.feedback_comments(uuid, date, date, int, uuid) is
  'Keyset-paged feedback comments. Manager or above. Stub until 2B-R7 (#298) replaces the body; the '
  'signature is fixed.';

create function api.duplicate_guest_candidates(p_org_id uuid, p_limit int default 50) returns setof api.duplicate_pair
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.duplicate_guest_candidates(uuid, int) is
  'Likely duplicate guest pairs of the org. Manager or above. Stub until 2B-C3 (#302) replaces the '
  'body; the signature is fixed.';

create function api.merge_guests(p_keep_id uuid, p_merge_id uuid, p_idempotency_key uuid) returns api.guest_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.merge_guests(uuid, uuid, uuid) is
  'Merges one guest into another, keeping all visits, contacts, tags and notes; audited, never '
  'deletes visits (I-1). Stub until 2B-C3 (#302) replaces the body; the signature is fixed.';

create function api.export_guests(p_org_id uuid) returns setof api.guest_export_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.export_guests(uuid) is
  'Exports the org''s guests; audited and size limited. Owner or admin. Stub until 2B-C5 (#304) '
  'replaces the body; the signature is fixed.';

create function api.import_guests(p_org_id uuid, p_rows jsonb, p_idempotency_key uuid) returns setof api.import_row_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.import_guests(uuid, jsonb, uuid) is
  'Imports guests row by row with a per-row outcome; audited and size limited. Owner or admin. Stub '
  'until 2B-C5 (#304) replaces the body; the signature is fixed.';

create function api.create_api_key(p_org_id uuid, p_name text, p_scopes text[], p_location_ids uuid[], p_expires_at timestamptz, p_idempotency_key uuid) returns api.api_key_created
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.create_api_key(uuid, text, text[], uuid[], timestamptz, uuid) is
  'Creates a scoped API key and returns the plaintext once; only its hash is stored. Owner or '
  'admin. Stub until 2B-I1 (#306) replaces the body; the signature is fixed.';

create function api.revoke_api_key(p_key_id uuid) returns api.api_key_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.revoke_api_key(uuid) is
  'Revokes a key; revoking twice is a no-op. Stub until 2B-I1 (#306) replaces the body; the '
  'signature is fixed.';

create function api.create_webhook_endpoint(p_org_id uuid, p_url text, p_kind text, p_event_types text[], p_include_guest_name boolean, p_idempotency_key uuid) returns api.webhook_endpoint_created
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.create_webhook_endpoint(uuid, text, text, text[], boolean, uuid) is
  'Registers a webhook endpoint and shows its signing secret once. Owner or admin. Stub until 2B-I6 '
  '(#311) replaces the body; the signature is fixed.';

create function api.claim_webhook_deliveries(p_limit int, p_lease_seconds int) returns setof api.webhook_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.claim_webhook_deliveries(int, int) is
  'Service role only: leases due webhook deliveries to the deliver-webhooks Edge Function. Stub '
  'until 2B-I6 (#311) replaces the body; the signature is fixed.';

create function api.report_webhook_result(p_delivery_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.report_webhook_result(uuid, jsonb) is
  'Service role only: records a delivery attempt''s outcome and schedules the retry. Stub until '
  '2B-I6 (#311) replaces the body; the signature is fixed.';

------------------------------------------------------------------------------------------------
-- Grants: anon (guest functions), authenticated (staff and admin), service_role only
------------------------------------------------------------------------------------------------

revoke all on function
  api.guest_add_companion(text, text, uuid),
  api.guest_remove_companion(text, uuid),
  api.guest_submit_feedback(text, int, int, text, uuid),
  api.guest_send_message(text, text, uuid),
  api.guest_list_messages(text, bigint),
  api.guest_create_link_code(text, text),
  api.guest_claim_offer(text, uuid),
  api.guest_leave_waitlist(text),
  api.book_event_seats(uuid, text, text, text, int, uuid),
  api.set_visit_priority(uuid, uuid, int, uuid),
  api.advance_journey(uuid, int, uuid),
  api.staff_set_companions(uuid, text[], int, uuid),
  api.staff_send_message(uuid, text, uuid),
  api.staff_mark_read(uuid, bigint),
  api.list_visit_notifications(uuid),
  api.list_failed_notifications(uuid, timestamptz),
  api.retry_notification(uuid, uuid),
  api.counter_display_snapshot(),
  api.set_member_locations(uuid, uuid[], uuid),
  api.org_overview(uuid),
  api.list_shifts(uuid, date, date),
  api.set_my_presence(uuid, text, uuid, uuid),
  api.cancel_event(uuid, text, uuid),
  api.block_time_bulk(uuid, uuid[], tstzrange[], text, uuid),
  api.search_appointments(uuid, text, date, date, text[], int, uuid),
  api.eta_accuracy(uuid, date, date, text),
  api.staff_performance(uuid, date, date, text),
  api.peak_heatmap(uuid, int, numeric),
  api.location_comparison(uuid, date, date),
  api.feedback_summary(uuid, date, date, text),
  api.feedback_comments(uuid, date, date, int, uuid),
  api.duplicate_guest_candidates(uuid, int),
  api.merge_guests(uuid, uuid, uuid),
  api.export_guests(uuid),
  api.import_guests(uuid, jsonb, uuid),
  api.create_api_key(uuid, text, text[], uuid[], timestamptz, uuid),
  api.revoke_api_key(uuid),
  api.create_webhook_endpoint(uuid, text, text, text[], boolean, uuid),
  api.redeem_link_code(text, text),
  api.claim_webhook_deliveries(int, int),
  api.report_webhook_result(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  api.guest_add_companion(text, text, uuid),
  api.guest_remove_companion(text, uuid),
  api.guest_submit_feedback(text, int, int, text, uuid),
  api.guest_send_message(text, text, uuid),
  api.guest_list_messages(text, bigint),
  api.guest_create_link_code(text, text),
  api.guest_claim_offer(text, uuid),
  api.guest_leave_waitlist(text),
  api.book_event_seats(uuid, text, text, text, int, uuid)
to anon, authenticated, service_role;
grant execute on function
  api.set_visit_priority(uuid, uuid, int, uuid),
  api.advance_journey(uuid, int, uuid),
  api.staff_set_companions(uuid, text[], int, uuid),
  api.staff_send_message(uuid, text, uuid),
  api.staff_mark_read(uuid, bigint),
  api.list_visit_notifications(uuid),
  api.list_failed_notifications(uuid, timestamptz),
  api.retry_notification(uuid, uuid),
  api.counter_display_snapshot(),
  api.set_member_locations(uuid, uuid[], uuid),
  api.org_overview(uuid),
  api.list_shifts(uuid, date, date),
  api.set_my_presence(uuid, text, uuid, uuid),
  api.cancel_event(uuid, text, uuid),
  api.block_time_bulk(uuid, uuid[], tstzrange[], text, uuid),
  api.search_appointments(uuid, text, date, date, text[], int, uuid),
  api.eta_accuracy(uuid, date, date, text),
  api.staff_performance(uuid, date, date, text),
  api.peak_heatmap(uuid, int, numeric),
  api.location_comparison(uuid, date, date),
  api.feedback_summary(uuid, date, date, text),
  api.feedback_comments(uuid, date, date, int, uuid),
  api.duplicate_guest_candidates(uuid, int),
  api.merge_guests(uuid, uuid, uuid),
  api.export_guests(uuid),
  api.import_guests(uuid, jsonb, uuid),
  api.create_api_key(uuid, text, text[], uuid[], timestamptz, uuid),
  api.revoke_api_key(uuid),
  api.create_webhook_endpoint(uuid, text, text, text[], boolean, uuid)
to authenticated, service_role;
grant execute on function
  api.redeem_link_code(text, text),
  api.claim_webhook_deliveries(int, int),
  api.report_webhook_result(uuid, jsonb)
to service_role;

notify pgrst, 'reload schema';
