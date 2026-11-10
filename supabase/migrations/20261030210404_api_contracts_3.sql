-- 3-API1: every phase 3 RPC whose signature is named in a ticket, so the parallel phase 3 epics
-- build against one set of types and db-types stays regenerable. Bodies raise not_implemented;
-- the owning ticket (named in each COMMENT) replaces its body with `create or replace` and must
-- not change a signature or a return type. Tables, triggers and private functions are not
-- stubbed: the owning ticket creates them. Only guest_grant_consent is anon-reachable.

-- Return types

create type api.webhook_record as (
  event_id bigint,
  is_duplicate boolean
);

create type api.consent_row as (
  consent_id uuid,
  contact_id uuid,
  channel text,
  purpose text,
  status text,
  captured_at timestamptz
);

create type api.inbound_result as (
  inbound_id uuid,
  handled_as text,
  contact_id uuid,
  visit_id uuid
);

create type api.channel_status as (
  channel text,
  enabled boolean,
  missing text[]
);

create type api.provider_settings_row as (
  org_id uuid,
  channel text,
  provider text,
  mode text,
  config jsonb,
  secret_hints jsonb,
  endpoint_id uuid,
  messaging_campaign_ref text,
  verified_at timestamptz,
  enabled boolean,
  version int
);

create type api.channel_config as (
  provider text,
  mode text,
  config jsonb,
  secrets jsonb,
  enabled boolean
);

create type api.webhook_secret as (
  org_id uuid,
  channel text,
  secrets jsonb
);

create type api.usage_row as (
  day date,
  channel text,
  provider text,
  messages int,
  segments int,
  cost_micros bigint,
  currency text
);

create type api.send_reservation as (
  decision text,
  sent_today int,
  daily_cap int
);

create type api.payment_row as (
  id uuid,
  visit_id uuid,
  appointment_id uuid,
  provider text,
  kind text,
  status text,
  amount_minor bigint,
  currency text,
  updated_at timestamptz
);

create type api.payment_job as (
  id uuid,
  org_id uuid,
  payment_id uuid,
  action text,
  amount_minor bigint,
  attempts int
);

create type api.custom_domain_row as (
  id uuid,
  org_id uuid,
  hostname text,
  default_location_id uuid,
  verification_token text,
  status text,
  verified_at timestamptz,
  last_checked_at timestamptz
);

grant usage on type
  api.webhook_record,
  api.consent_row,
  api.inbound_result,
  api.channel_status,
  api.provider_settings_row,
  api.channel_config,
  api.webhook_secret,
  api.usage_row,
  api.send_reservation,
  api.payment_row,
  api.payment_job,
  api.custom_domain_row
to authenticated, service_role;
grant usage on type api.consent_row to anon;

-- Stubs

create function api.record_webhook_event(p_provider text, p_event_key text, p_org_id uuid, p_payload jsonb) returns api.webhook_record
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.record_webhook_event(text, text, uuid, jsonb) is
  'Service role only (provider-webhook): stores the event once per (provider, event key); a repeat returns is_duplicate = true and changes nothing. Stub until 3-CG1 (#326) replaces the body; the signature is fixed.';

create function api.mark_webhook_processed(p_event_id bigint, p_error text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.mark_webhook_processed(bigint, text) is
  'Service role only: stamps processed_at and the error, if any. Repeats are no-ops. Stub until 3-CG1 (#326) replaces the body; the signature is fixed.';

create function api.staff_capture_consent(p_visit_id uuid, p_channel text, p_attested boolean, p_text_version int, p_idempotency_key uuid) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_capture_consent(uuid, text, boolean, int, uuid) is
  'Records a staff-attested transactional consent for the visit''s phone. Staff of the location; raises attestation_required, contact_suppressed, not_found. Idempotent per key. Stub until 3-CG3 (#328) replaces the body; the signature is fixed.';

create function api.guest_grant_consent(p_token text, p_channel text, p_text_version int, p_text_hash text, p_locale text) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.guest_grant_consent(text, text, int, text, text) is
  'Grants a transactional SMS or WhatsApp consent for the token''s open visit after checking the hash of the text the guest saw. Raises not_found, consent_text_mismatch, contact_suppressed, rate_limited. Idempotent per contact and channel. Stub until 3-CG5 (#330) replaces the body; the signature is fixed.';

create function api.process_inbound_message(p_org_id uuid, p_channel text, p_from text, p_to text, p_body text, p_provider text, p_provider_message_id text) returns api.inbound_result
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.process_inbound_message(uuid, text, text, text, text, text, text) is
  'Service role only (provider-webhook): stores an inbound message once and applies STOP, START and HELP keywords; anything else returns handled_as = ''unhandled''. Stub until 3-CG8 (#333) replaces the body; the signature is fixed.';

create function api.set_channel_enabled(p_org_id uuid, p_channel text, p_enabled boolean, p_idempotency_key uuid) returns api.channel_status
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_channel_enabled(uuid, text, boolean, uuid) is
  'Owner only. Enabling a paid channel raises channel_prerequisite_missing (DETAIL lists what is missing); disabling is always allowed. Stub until 3-CG13 (#338) replaces the body; the signature is fixed.';

create function api.set_provider_settings(p_org_id uuid, p_channel text, p_provider text, p_mode text, p_config jsonb, p_secrets jsonb, p_idempotency_key uuid) returns api.provider_settings_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.set_provider_settings(uuid, text, text, text, jsonb, jsonb, uuid) is
  'Owner or admin: saves non-secret config and stores secrets in Vault (only ids and last four characters are readable). Never enables the channel. Stub until 3-PV1 (#340) replaces the body; the signature is fixed.';

create function api.get_channel_config(p_org_id uuid, p_channel text) returns api.channel_config
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.get_channel_config(uuid, text) is
  'Service role only (dispatcher): the org''s decrypted provider config for a channel, or an empty row when none is enabled. Stub until 3-PV1 (#340) replaces the body; the signature is fixed.';

create function api.get_webhook_secret(p_provider text, p_endpoint_id uuid) returns api.webhook_secret
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.get_webhook_secret(text, uuid) is
  'Service role only (provider-webhook): the secrets that verify a provider''s signature for one endpoint. Stub until 3-PV1 (#340) replaces the body; the signature is fixed.';

create function api.usage_summary(p_org_id uuid, p_from date, p_to date) returns setof api.usage_row
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.usage_summary(uuid, date, date) is
  'Messages, segments and cost per day, channel and provider (UTC days). Manager or above; raises range_too_large. Stub until 3-PV4 (#343) replaces the body; the signature is fixed.';

create function api.reserve_send(p_outbox_id uuid) returns api.send_reservation
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked or budget_reached for one paid send and counts it when allowed. Stub until 3-PV6 (#345) replaces the body; the signature is fixed.';

create function api.staff_charge_no_show(p_payment_id uuid, p_idempotency_key uuid) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_charge_no_show(uuid, uuid) is
  'Queues the no-show fee on a stored card. Manager or above of the location; the visit must be a no-show. Idempotent per key. Stub until 3-PAY2 (#363) replaces the body; the signature is fixed.';

create function api.staff_refund_payment(p_payment_id uuid, p_amount_minor bigint, p_reason text, p_idempotency_key uuid) returns api.payment_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.staff_refund_payment(uuid, bigint, text, uuid) is
  'Queues a full or partial refund. Manager or above of the location. Idempotent per key. Stub until 3-PAY2 (#363) replaces the body; the signature is fixed.';

create function api.claim_payment_jobs(p_limit int, p_lease_seconds int) returns setof api.payment_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.claim_payment_jobs(int, int) is
  'Service role only (payment job runner): leases due jobs, oldest first. Stub until 3-PAY2 (#363) replaces the body; the signature is fixed.';

create function api.report_payment_result(p_job_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.report_payment_result(uuid, jsonb) is
  'Service role only: records a job outcome and updates the payment. Repeats are no-ops. Stub until 3-PAY2 (#363) replaces the body; the signature is fixed.';

create function api.add_custom_domain(p_org_id uuid, p_hostname text, p_location_id uuid, p_idempotency_key uuid) returns api.custom_domain_row
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.add_custom_domain(uuid, text, uuid, uuid) is
  'Owner or admin: registers a hostname for verification. Raises invalid_input, already_exists. Idempotent per key. Stub until 3-DOM1 (#370) replaces the body; the signature is fixed.';

create function api.remove_custom_domain(p_domain_id uuid, p_idempotency_key uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception 'not_implemented';
end $$;
comment on function api.remove_custom_domain(uuid, uuid) is
  'Owner or admin: removes a hostname; a repeat is a no-op. Stub until 3-DOM1 (#370) replaces the body; the signature is fixed.';

revoke all on function
  api.guest_grant_consent(text, text, int, text, text),
  api.staff_capture_consent(uuid, text, boolean, int, uuid),
  api.set_channel_enabled(uuid, text, boolean, uuid),
  api.set_provider_settings(uuid, text, text, text, jsonb, jsonb, uuid),
  api.usage_summary(uuid, date, date),
  api.staff_charge_no_show(uuid, uuid),
  api.staff_refund_payment(uuid, bigint, text, uuid),
  api.add_custom_domain(uuid, text, uuid, uuid),
  api.remove_custom_domain(uuid, uuid),
  api.record_webhook_event(text, text, uuid, jsonb),
  api.mark_webhook_processed(bigint, text),
  api.process_inbound_message(uuid, text, text, text, text, text, text),
  api.get_channel_config(uuid, text),
  api.get_webhook_secret(text, uuid),
  api.reserve_send(uuid),
  api.claim_payment_jobs(int, int),
  api.report_payment_result(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  api.guest_grant_consent(text, text, int, text, text)
to anon, authenticated, service_role;
grant execute on function
  api.staff_capture_consent(uuid, text, boolean, int, uuid),
  api.set_channel_enabled(uuid, text, boolean, uuid),
  api.set_provider_settings(uuid, text, text, text, jsonb, jsonb, uuid),
  api.usage_summary(uuid, date, date),
  api.staff_charge_no_show(uuid, uuid),
  api.staff_refund_payment(uuid, bigint, text, uuid),
  api.add_custom_domain(uuid, text, uuid, uuid),
  api.remove_custom_domain(uuid, uuid)
to authenticated, service_role;
grant execute on function
  api.record_webhook_event(text, text, uuid, jsonb),
  api.mark_webhook_processed(bigint, text),
  api.process_inbound_message(uuid, text, text, text, text, text, text),
  api.get_channel_config(uuid, text),
  api.get_webhook_secret(text, uuid),
  api.reserve_send(uuid),
  api.claim_payment_jobs(int, int),
  api.report_payment_result(uuid, jsonb)
to service_role;

notify pgrst, 'reload schema';
