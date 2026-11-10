-- The open-source build has no hosted operator and no billing. This removes what only the hosted
-- service used: the operator console's tables and functions (app.platform_*, api.platform_*),
-- plans, subscriptions and prepaid message credit, the shared-sender SMS health tracking, the
-- operator incident register and its notices.
--
-- What stays, and why:
--   app.platform_flags       the compliance gate and the support inbox are read by tenant code
--   app.entitlement_defaults deployment-wide limits; private.entitlement now reads only these and
--   app.org_entitlements     the per-business overrides (both are set with SQL, see docs/selfhost)
--   app.support_grants       kept so old bundles do not fail; private.support_grant never returns
--                            a grant, so membership alone decides access
--   app.org_incident_log     a business's own incident log
--   operator_sessions etc.   the shared-tablet PIN switch is a tenant feature despite the name
--
-- Tenant functions that touched the removed objects are redefined below without them; their
-- signatures and grants are unchanged.

-- 1. Scheduled jobs
select cron.unschedule('platform-stats-tick');
select cron.unschedule('kick-billing-jobs');
select cron.unschedule('payment-grace-reminders');
select cron.unschedule('pause-unhealthy-platform-sms');
select cron.unschedule('platform-sms-tick');
select cron.unschedule('platform-sms-digest');

-- 2. Triggers and policies on tables that stay
drop trigger sync_subscription_quantity on app.locations;
-- Only the operator console read these two directly. No signed-in user does now: tenants get their
-- resolved values from api.org_entitlements().
drop policy entitlement_defaults_select on app.entitlement_defaults;
drop policy org_entitlements_select on app.org_entitlements;
create policy entitlement_defaults_none on app.entitlement_defaults for select to authenticated using (false);
create policy org_entitlements_none on app.org_entitlements for select to authenticated using (false);

-- 3. Tables, and what hangs off their row types
drop view app.credit_balance;
drop function private.incident_row(app.platform_incidents);
drop function private.incident_notice_row(app.incident_notices);
drop function api.platform_sms_analytics(p_from date, p_to date, p_org_id uuid);
drop function api.platform_stats(p_from date, p_to date);
drop table app.incident_notices;
drop table app.platform_incident_events;
drop table app.platform_incidents;
drop table app.platform_announcements;
drop table app.platform_attention_acks;
drop table app.platform_audit;
drop table app.platform_blocks;
drop table app.platform_daily_stats;
drop table app.platform_org_notes;
drop table app.platform_roles;
drop table app.platform_sms_daily;
drop table private.platform_sms_pauses;
drop table private.platform_sms_stops;
drop table app.billing_jobs;
drop table app.credit_ledger;
drop table app.plan_entitlements;
drop table app.subscriptions;
drop table app.plans;

-- 4. Functions
drop function api.apply_billing_event(p_type text, p_created timestamp with time zone, p_org_id uuid, p_customer_id text, p_subscription_id text, p_status text, p_price_id text, p_quantity integer, p_period_end timestamp with time zone);
drop function api.apply_bundle_grant(p_invoice_id text, p_subscription_id text, p_created timestamp with time zone);
drop function api.apply_credit_topup(p_session_id text, p_org_id uuid, p_amount_minor bigint, p_currency text);
drop function api.apply_platform_sms_event(p_kind text, p_phone text, p_provider_message_id text, p_status text, p_error_code text);
drop function api.billing_session_info(p_org_id uuid, p_interval text);
drop function api.claim_billing_jobs(p_limit integer, p_lease_seconds integer);
drop function api.org_billing(p_org_id uuid);
drop function api.platform_ack_attention(p_org_id uuid, p_reason text, p_hours integer);
drop function api.platform_add_incident_note(p_id uuid, p_body text);
drop function api.platform_add_note(p_org_id uuid, p_body text, p_tags text[], p_note_id uuid, p_idempotency_key uuid);
drop function api.platform_approve_notice(p_id uuid);
drop function api.platform_attention(p_limit integer);
drop function api.platform_audit_export(p_actor uuid, p_org_id uuid, p_action text, p_from timestamp with time zone, p_to timestamp with time zone, p_after bigint);
drop function api.platform_audit_search(p_actor uuid, p_org_id uuid, p_action text, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_after bigint);
drop function api.platform_billing_overview();
drop function api.platform_block_contact(p_value text, p_kind text, p_reason text, p_expires_at timestamp with time zone);
drop function api.platform_break_glass(p_org_id uuid, p_reason text);
drop function api.platform_create_incident(p_kind text, p_title text, p_detected_at timestamp with time zone, p_description text, p_org_ids uuid[], p_data_categories text[], p_record_count integer, p_idempotency_key uuid);
drop function api.platform_delivery_summary(p_from timestamp with time zone, p_to timestamp with time zone);
drop function api.platform_funnel(p_from date, p_to date, p_stage text, p_limit integer, p_offset integer);
drop function api.platform_get_org(p_org_id uuid);
drop function api.platform_health();
drop function api.platform_incident_break_glass(p_id uuid);
drop function api.platform_incident_tenants(p_id uuid);
drop function api.platform_list_announcements();
drop function api.platform_list_incidents(p_status app.incident_status, p_id uuid);
drop function api.platform_list_notes(p_org_id uuid, p_include_history boolean);
drop function api.platform_list_notices(p_incident_id uuid);
drop function api.platform_list_orgs(p_search text, p_status app.org_status, p_limit integer, p_after uuid);
drop function api.platform_list_support_requests(p_org_id uuid, p_status text);
drop function api.platform_org_activation(p_org_ids uuid[]);
drop function api.platform_org_billing(p_org_id uuid);
drop function api.platform_org_deliveries(p_org_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_status text, p_channel text, p_limit integer, p_after_at timestamp with time zone, p_after_id uuid);
drop function api.platform_revoke_devices(p_org_id uuid, p_reason text);
drop function api.platform_revoke_role(p_user_id uuid, p_allow_last_operator boolean);
drop function api.platform_save_notice(p_incident_id uuid, p_subject text, p_body text);
drop function api.platform_search_visits(p_org_id uuid, p_ticket text, p_service_day date, p_queue_id uuid, p_status api.visit_state, p_limit integer);
drop function api.platform_send_notice(p_id uuid);
drop function api.platform_set_entitlement(p_org_id uuid, p_key text, p_value jsonb, p_reason text);
drop function api.platform_set_org_status(p_org_id uuid, p_status app.org_status, p_reason text);
drop function api.platform_set_sms_pause(p_org_id uuid, p_pause boolean, p_reason text);
drop function api.platform_set_support_request_status(p_request_id uuid, p_status text);
drop function api.platform_sign_out_members(p_org_id uuid, p_reason text);
drop function api.platform_sms_health(p_org_id uuid);
drop function api.platform_tagged_orgs(p_tags text[]);
drop function api.platform_team();
drop function api.platform_transfer_ownership(p_org_id uuid, p_new_owner_email text, p_reason text);
drop function api.platform_unblock_contact(p_value text, p_kind text);
drop function api.platform_update_incident(p_id uuid, p_status app.incident_status, p_org_ids uuid[], p_data_categories text[], p_record_count integer, p_containment text, p_root_cause text, p_lessons text, p_mark_notified boolean, p_waive_reason text);
drop function api.platform_upsert_announcement(p_severity app.announcement_severity, p_message text, p_ends_at timestamp with time zone, p_starts_at timestamp with time zone, p_id uuid);
drop function api.platform_visit_timeline(p_org_id uuid, p_visit_id uuid);
drop function api.platform_whoami();
drop function api.report_billing_result(p_job_id uuid, p_result jsonb);
drop function ops.kick_billing_jobs_if_due();
drop function ops.pause_unhealthy_platform_sms();
drop function ops.platform_sms_digest();
drop function ops.platform_sms_tick();
drop function ops.platform_stats_tick();
drop function ops.send_payment_grace_reminders();
drop function private.audit_platform_announcement();
drop function private.audit_platform_role();
drop function private.billing_enabled();
drop function private.check_credit_low(p_org_id uuid);
drop function private.credit_balance(p_org_id uuid);
drop function private.credit_margin(p_cost bigint);
drop function private.debit_credit(p_notification_id uuid, p_org_id uuid, p_cost bigint);
drop function private.enqueue_payment_email(p_org_id uuid, p_template text);
drop function private.forbid_incident_event_change();
drop function private.forbid_platform_audit_change();
drop function private.forbid_platform_note_change();
drop function private.incident_event(p_id uuid, p_kind text, p_body text);
drop function private.is_platform(p_min app.platform_role);
drop function private.notify_sms_paused(p_org_id uuid, p_breach text, p_stats jsonb);
drop function private.notify_sms_warning(p_org_id uuid, p_metric text, p_stats jsonb);
drop function private.org_plan(p_org_id uuid);
drop function private.platform_attention_raw();
drop function private.platform_audit(p_action text, p_org_id uuid, p_target jsonb, p_reason text);
drop function private.platform_audit_rows(p_own_only boolean, p_actor uuid, p_org_id uuid, p_action text, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_after bigint);
drop function private.platform_org_note_row(p_version_id uuid);
drop function private.platform_org_row(p_org_id uuid);
drop function private.platform_sms_backfill_days();
drop function private.platform_sms_breach(p_stats jsonb);
drop function private.platform_sms_country(p_e164 text);
drop function private.platform_sms_paused(p_org_id uuid, p_channel text);
drop function private.platform_sms_rollup(p_today date);
drop function private.platform_sms_stats(p_org_id uuid);
drop function private.platform_sms_threshold(p_metric text, p_sent numeric);
drop function private.platform_sms_warning(p_stats jsonb);
drop function private.platform_stats(p_today date);
drop function private.platform_stats_backfill_days();
drop function private.require_platform(p_min app.platform_role);
drop function private.sync_quantity_on_location();
drop function private.sync_subscription_quantity(p_org_id uuid);
drop function private.uses_platform_credit(p_org_id uuid, p_channel text);

drop function private.org_activation(uuid[], timestamp with time zone, timestamp with time zone);
drop function private.require_support_grant(uuid);
drop function api.acknowledge_incident_notice(uuid);

-- 5. Types
drop type api.platform_funnel_result;
drop type api.platform_visit_timeline;
drop type api.platform_audit_export;
drop type api.platform_org_detail;
drop type api.platform_delivery_row;
drop type api.platform_delivery_summary_row;
drop type api.platform_audit_row;
drop type api.platform_billing_overview;
drop type api.platform_incident;
drop type app.incident_status;
drop type api.platform_activation;
drop type api.platform_visit_hit;
drop type api.platform_org_note;
drop type api.platform_org_row;
drop type api.platform_incident_tenant;
drop type api.platform_incident_break_glass;
drop type api.platform_support_request;
drop type api.platform_org_billing;
drop type app.platform_role;
drop type api.platform_health;
drop type api.platform_attention_row;
drop type api.platform_tagged_org;
drop type api.incident_notice;
drop type app.announcement_severity;

-- 6. Hosted-billing settings
alter table app.platform_flags
  drop column billing_enabled,
  drop column sms_margin_bps,
  drop column credit_low_micros,
  drop column sms_bundle_grant_micros;

-- The support request email named the org's plan and linked to its page in the operator console.
update app.notification_templates
set body = replace(replace(body, ', plan {{plan}}', ''), E'[Tenant page: {{app_url}}/platform/orgs/{{org_id}}]\n', ''),
    version = version + 1
where org_id is null and queue_id is null and trigger = 'support_request'
  and body like '%/platform/orgs/%';

-- 7. Tenant functions, without the hosted parts

-- redefines private.entitlement from 20261031030923_billing.sql
create or replace function private.entitlement(p_org_id uuid, p_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (select o.value from app.org_entitlements o where o.org_id = p_org_id and o.key = p_key),
    (select d.value from app.entitlement_defaults d where d.key = p_key)
  )
$function$;

-- redefines private.channel_missing from 20261109130339_org_privacy_contact.sql
create or replace function private.channel_missing(p_org_id uuid, p_channel text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f app.platform_flags;
  s app.provider_settings;
  l app.channel_limits;
  missing text[] := '{}';
begin
  select * into f from app.platform_flags;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
  if p_channel = 'sms' and not private.privacy_contact_recorded(p_org_id) then
    missing := array_append(missing, 'privacy_contact');
  end if;
  if p_channel in ('sms', 'whatsapp') and not private.entitled(p_org_id, 'paid_channels') then
    missing := array_append(missing, 'plan_allows_paid_channels');
  end if;
  -- the SMS compliance gate and the provider test event do not apply to an LLM key
  if p_channel not in ('llm', 'pos', 'crm') and f.compliance_gate_passed_at is null then missing := array_append(missing, 'compliance_gate'); end if;
  if not found then
    return array_append(missing, 'provider_settings');
  end if;
  if s.mode = 'platform' and f.hosted_legal_reviewed_at is null then missing := array_append(missing, 'hosted_legal_review'); end if;
  -- The deployment's kill switch holds for orgs already enabled (get_channel_config re-checks on every dispatch).
  if s.mode = 'platform' and not (select d.platform_messaging_enabled from private.deployment_settings d) then
    missing := array_append(missing, 'platform_messaging');
  end if;
  -- Platform-paid SMS belongs to the hosted service, which bills for it. This build has no billing.
  if s.mode = 'platform' and p_channel = 'sms' then
    missing := array_append(missing, 'platform_requires_billing');
  end if;
  if s.verified_at is null and p_channel <> 'llm' then missing := array_append(missing, 'provider_verified'); end if;
  if p_channel = 'sms' then
    select * into l from app.channel_limits where org_id = p_org_id and channel = 'sms';
    -- no row means the defaults: a cap of 200 and no allowed country
    if coalesce(l.daily_cap, 200) <= 0 then missing := array_append(missing, 'daily_cap'); end if;
    if coalesce(cardinality(l.country_allowlist), 0) = 0 then missing := array_append(missing, 'country_allowlist'); end if;
    -- A US campaign is needed unless the sender is known to be outside +1 and no allowed country shares +1
    -- (the allowlist is matched against the number's calling code, so CA admits US numbers too).
    if (exists (select 1 from app.dial_codes d where d.prefix = '1' and d.country_code = any (coalesce(l.country_allowlist, '{}')))
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') !~ '^\+'
        or regexp_replace(coalesce(s.config ->> 'from_number', ''), '\s', '', 'g') like '+1%')
       and coalesce(s.messaging_campaign_ref, '') = '' then
      missing := array_append(missing, 'campaign_ref');
    end if;
  end if;
  return missing;
end $function$;

-- redefines private.is_blocked from 20261029215747_platform_blocks.sql
create or replace function private.is_blocked(p_org_id uuid, p_phone_e164 text, p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  -- The contact blocklist was kept by the hosted service's operators. Nothing is blocked here.
  return false;
end $function$;

-- redefines private.support_grant from 20261025003620_support_grants.sql
create or replace function private.support_grant(p_org_id uuid)
 RETURNS app.support_grants
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- A support grant gave the hosted service's operators access. There are none here, so no grant
  -- is ever in force and private.has_role decides on membership alone.
  select g.* from app.support_grants g where false
$function$;

-- redefines api.reserve_send from 20261102085037_platform_sms_auto_pause.sql
create or replace function api.reserve_send(p_outbox_id uuid)
 RETURNS api.send_reservation
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n app.notifications;
  v_limits app.channel_limits;
  v_cap int;
  v_countries text[];
  v_day date := (now() at time zone 'UTC')::date;
  v_sent int;
  v_spent bigint;
  v_threshold int;
  v_budget bigint;
begin
  select * into n from app.notifications where id = p_outbox_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into v_limits from app.channel_limits l where l.org_id = n.org_id and l.channel = n.channel;
  -- The operator ceiling bounds the org's own limit, which org admins can edit.
  v_cap := least(coalesce(v_limits.daily_cap, private.messaging_daily_ceiling(n.org_id)), private.messaging_daily_ceiling(n.org_id));

  -- Serialise on the day's counter row: concurrent dispatchers queue here, so the cap is exact.
  insert into app.usage_counters (org_id, channel, day) values (n.org_id, n.channel, v_day)
  on conflict do nothing;
  select c.sent into v_sent from app.usage_counters c
  where c.org_id = n.org_id and c.channel = n.channel and c.day = v_day for update;

  select * into n from app.notifications where id = p_outbox_id;
  if n.reserved_at is not null then
    return row('allowed', v_sent, v_cap)::api.send_reservation;
  end if;

  -- An unknown country cannot be on the allowlist.
  select private.phone_countries(c.value) into v_countries
  from app.guest_contacts c where c.id = n.recipient_ref and c.org_id = n.org_id;
  if v_countries is null or not (v_countries && coalesce(v_limits.country_allowlist, '{}')) then
    return row('country_blocked', v_sent, v_cap)::api.send_reservation;
  end if;
  if v_sent >= v_cap then
    return row('cap_reached', v_sent, v_cap)::api.send_reservation;
  end if;
  v_budget := least(coalesce(v_limits.monthly_budget_micros, private.messaging_budget_ceiling(n.org_id)), private.messaging_budget_ceiling(n.org_id));
  select coalesce(sum(s.cost_micros), 0) into v_spent from app.notifications s
  where s.org_id = n.org_id and s.channel = n.channel and s.status = 'sent'
    and s.sent_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  if v_spent >= v_budget then
    return row('budget_reached', v_sent, v_cap)::api.send_reservation;
  end if;

  update app.usage_counters set sent = sent + 1
  where org_id = n.org_id and channel = n.channel and day = v_day;
  update app.notifications set reserved_at = now() where id = n.id;
  -- One alert per threshold, channel and UTC day: the first send that reaches 80% and the one that reaches 100%.
  foreach v_threshold in array array[80, 100] loop
    if v_cap > 0 and (v_sent + 1) * 100 >= v_threshold * v_cap then
      insert into app.usage_alerts (org_id, channel, day, threshold) values (n.org_id, n.channel, v_day, v_threshold)
      on conflict do nothing;
      if found then
        perform private.enqueue_usage_alert(n.org_id, n.channel, v_day, v_threshold, v_sent + 1, v_cap);
      end if;
    end if;
  end loop;
  return row('allowed', v_sent + 1, v_cap)::api.send_reservation;
end $function$;

-- redefines api.report_outbox_result from 20261031040553_sms_credits.sql
create or replace function api.report_outbox_result(p_outbox_id uuid, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n app.notifications;
  v_status text := p_result ->> 'status';
  v_code text := left(p_result ->> 'error_code', 100);
  v_provider text;
  v_segments int := (p_result ->> 'segments')::int;
  v_cost bigint := (p_result ->> 'cost_micros')::bigint;
  v_source text;
  v_currency char(3);
  v_rate app.provider_rates;
begin
  if v_status is null or v_status not in ('sent', 'failed', 'suppressed', 'gone') then
    raise exception 'invalid_input';
  end if;
  select * into n from app.notifications where id = p_outbox_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- A report for a row this dispatcher no longer holds (its lease expired) changes nothing.
  if n.status <> 'claimed' then
    return;
  end if;

  v_provider := coalesce(left(p_result ->> 'provider', 50), n.provider);
  if v_status = 'sent' then
    if v_cost is not null then
      v_source := 'provider';
      v_currency := coalesce(left(p_result ->> 'currency', 3), 'USD');
    elsif n.channel in ('sms', 'whatsapp') then
      -- The provider quoted no price: estimate from the rate table and reconcile later (3-SMS2).
      v_rate := private.message_rate(n.org_id, v_provider, n.channel,
        (select c.country_code from app.guest_contacts c where c.id = n.recipient_ref and c.org_id = n.org_id));
      if v_rate.id is not null then
        v_segments := coalesce(v_segments, 1);
        v_cost := v_segments * v_rate.micros_per_unit;
        v_currency := v_rate.currency;
        v_source := 'estimate';
      end if;
    end if;
  end if;

  update app.notifications set
    status = case
      when v_status = 'sent' then 'sent'
      when v_status = 'suppressed' and v_code = 'quiet_hours' then 'queued'
      when v_status = 'suppressed' then 'suppressed'
      when v_status = 'failed' and coalesce((p_result ->> 'retryable')::boolean, false)
           and n.attempts + 1 < private.outbox_max_attempts() then 'failed'
      else 'dead'
    end::app.notification_status,
    attempts = n.attempts + case when v_status in ('failed', 'gone') then 1 else 0 end,
    -- 30 s, 1, 2, 4, 8 min; quiet hours look again every 15 min until the window opens.
    next_attempt_at = case
      when v_status = 'failed' then now() + interval '30 seconds' * power(2, n.attempts)
      when v_code = 'quiet_hours' then now() + interval '15 minutes'
      else n.next_attempt_at
    end,
    quiet_hours_deferred = n.quiet_hours_deferred or v_code is not distinct from 'quiet_hours',
    locked_until = null,
    provider = v_provider,
    provider_message_id = left(p_result ->> 'provider_message_id', 200),
    error_code = case when v_status = 'gone' then coalesce(v_code, 'gone') else v_code end,
    segments = v_segments,
    cost_micros = v_cost,
    currency = coalesce(v_currency, n.currency),
    cost_source = v_source,
    sent_at = case when v_status = 'sent' then now() else n.sent_at end
  where id = n.id;

  -- A push service that answers 404/410 has dropped the subscription for good.
  if v_status = 'gone' and n.channel = 'push' then
    delete from app.push_subscriptions s where s.id = n.recipient_ref and s.org_id = n.org_id;
  end if;
  -- An email or SMS that is gone bounced hard, or the recipient complained (error_code
  -- complaint); claim_outbox honours both in every org. error_code unsubscribed (the guest opted out
  -- of this org's sender, e.g. Twilio 21610) is a per-org stop: it must not block other orgs.
  if v_status = 'gone' and n.channel <> 'push' then
    insert into app.suppressions (org_id, channel, value, reason)
    select n.org_id, n.channel, a.value, case v_code when 'complaint' then 'complaint' when 'unsubscribed' then 'stop' else 'bounce' end
    from (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
    where a.value is not null
    on conflict (org_id, channel, value) do nothing;
  end if;
end $function$;

-- redefines api.apply_provider_price from 20261031040553_sms_credits.sql
create or replace function api.apply_provider_price(p_org_id uuid, p_notification_id uuid, p_price numeric, p_currency text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform 1 from app.notifications n
  where n.id = p_notification_id and n.org_id = p_org_id and n.cost_source = 'estimate' for update;
  if not found then return; end if;
  update app.notifications n set
    price_checked_at = now(),
    cost_micros = case when p_price is null then n.cost_micros else round(abs(p_price) * 1000000)::bigint end,
    currency = case when p_price is null then n.currency else upper(left(coalesce(p_currency, n.currency), 3)) end,
    cost_source = case when p_price is null then n.cost_source else 'provider' end
  where n.id = p_notification_id and n.org_id = p_org_id;
end $function$;

-- redefines api.report_incident from 20261109132212_incident_notices.sql
create or replace function api.report_incident(p_org_id uuid, p_kind text, p_title text, p_description text DEFAULT NULL::text, p_detected_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_data_categories text[] DEFAULT '{}'::text[], p_notify_platform boolean DEFAULT true, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_title text := btrim(coalesce(p_title, ''));
  v_at timestamptz := coalesce(p_detected_at, now());
  v_cats text[] := coalesce((select array_agg(distinct c) from unnest(p_data_categories) c), '{}');
  v_replay boolean;
  v_saved jsonb;
  v_id uuid;
begin
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'invalid_input';
  end if;
  if p_idempotency_key is not null then
    select c.replay, c.response into v_replay, v_saved
    from private.claim_idempotent(p_org_id, 'report_incident', p_idempotency_key) c;
    if v_replay then
      return (v_saved ->> 'id')::uuid;
    end if;
  end if;
  -- p_notify_platform is kept for old bundles and ignored: there is no hosted operator to notify,
  -- so every report is an entry in the business's own log.
  begin
    insert into app.org_incident_log (org_id, source, kind, title, description, data_categories,
                                      detected_at, created_by)
    values (p_org_id, 'manual', p_kind, v_title, nullif(btrim(p_description), ''), v_cats, v_at, v_uid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input';
  end;
  if p_idempotency_key is not null then
    perform private.save_idempotent('report_incident', p_idempotency_key, jsonb_build_object('id', v_id));
  end if;
  return v_id;
end $function$;

-- redefines api.contact_support from 20261102075216_contact_support.sql
create or replace function api.contact_support(p_org_id uuid, p_subject text, p_message text, p_context jsonb DEFAULT NULL::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  uid uuid := (select auth.uid());
  v_role app.member_role;
  v_subject text := btrim(coalesce(p_subject, ''), E' \t\r\n');
  v_message text := btrim(coalesce(p_message, ''), E' \t\r\n');
  v_in jsonb := coalesce(p_context, '{}');
  v_context jsonb;
  v_viewport jsonb;
  v_w int;
  v_h int;
  v_browser text;
  v_version text;
  v_error text;
  v_org text;
  v_email text;
  r app.support_requests;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Only a member of the org, whatever its status. A stranger and a missing org look the same.
  select m.role into v_role from app.memberships m where m.org_id = p_org_id and m.user_id = uid;
  if not found then
    raise exception 'not_found';
  end if;

  if length(v_subject) not between 1 and 120 or v_subject ~ '[[:cntrl:]]'
     or length(v_message) not between 1 and 4000
     or regexp_replace(v_message, '[' || E'\n\r\t' || ']', '', 'g') ~ '[[:cntrl:]]'
     or jsonb_typeof(v_in) <> 'object' or length(v_in::text) > 4000 then
    raise exception 'invalid_input';
  end if;

  -- One person at a time, so the duplicate check and the rate limit cannot race.
  perform pg_advisory_xact_lock(hashtextextended('support_request:' || uid, 0));

  -- The same words again within a minute is a double click: same reference, nothing new sent.
  select * into r from app.support_requests x
  where x.user_id = uid and x.org_id = p_org_id and x.subject = v_subject and x.message = v_message
    and x.created_at > now() - interval '60 seconds'
  order by x.created_at desc limit 1;
  if found then
    return 'SR-' || lpad(r.number::text, 6, '0');
  end if;

  if (select count(*) from app.support_requests x
      where x.user_id = uid and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;

  -- Whitelist: nothing else in p_context is kept (no storage, tokens, query strings or guest data).
  v_viewport := v_in -> 'viewport';
  if jsonb_typeof(v_viewport) = 'object'
     and jsonb_typeof(v_viewport -> 'w') = 'number' and jsonb_typeof(v_viewport -> 'h') = 'number' then
    v_w := least(greatest(round((v_viewport ->> 'w')::numeric), 0), 20000);
    v_h := least(greatest(round((v_viewport ->> 'h')::numeric), 0), 20000);
  end if;
  v_browser := case when jsonb_typeof(v_in -> 'browser') = 'string'
                    and (v_in ->> 'browser') !~ '[[:cntrl:]]' then left(v_in ->> 'browser', 200) end;
  v_version := case when jsonb_typeof(v_in -> 'app_version') = 'string'
                    and (v_in ->> 'app_version') ~ '^[A-Za-z0-9._-]{1,40}$' then v_in ->> 'app_version' end;
  v_error := case when jsonb_typeof(v_in -> 'last_error_id') = 'string'
                  and (v_in ->> 'last_error_id') ~ '^[A-Za-z0-9_-]{1,64}$' then v_in ->> 'last_error_id' end;

  select o.name into v_org from app.organizations o where o.id = p_org_id;
  v_context := jsonb_strip_nulls(jsonb_build_object(
    'route', case when jsonb_typeof(v_in -> 'route') = 'string' then private.support_route(v_in ->> 'route') end,
    'app_version', v_version,
    'browser', v_browser,
    'viewport', case when v_w > 0 and v_h > 0 then jsonb_build_object('w', v_w, 'h', v_h) end,
    'online', case when jsonb_typeof(v_in -> 'online') = 'boolean' then v_in -> 'online' end,
    'last_error_id', v_error,
    'org_name', v_org,
    'role', v_role));

  insert into app.support_requests (org_id, user_id, subject, message, context)
  values (p_org_id, uid, v_subject, v_message, v_context)
  returning * into r;

  select u.email into v_email from auth.users u where u.id = uid;

  -- To the support inbox (private.notification_address resolves the recipient from the request), I-11.
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key)
  select p_org_id, null, 'email', r.id, 'support_request', t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object(
           'reference', 'SR-' || lpad(r.number::text, 6, '0'),
           'org', v_org, 'org_id', p_org_id, 'role', v_role,
           'user_email', v_email, 'subject', v_subject, 'message', v_message,
           'route', v_context ->> 'route', 'app_version', v_version, 'browser', v_browser,
           'viewport', case when v_w > 0 and v_h > 0 then v_w || 'x' || v_h end,
           'online', v_context ->> 'online', 'last_error_id', v_error)),
         'support_request:' || r.id
  from app.organizations o
  cross join lateral private.resolve_template(p_org_id, null, 'support_request', 'email', o.default_locale) t
  where o.id = p_org_id;

  -- To the requester, with the reference and no copy of the message.
  perform private.enqueue_user_email(
    p_org_id, uid, 'support_confirmation',
    jsonb_build_object('reference', 'SR-' || lpad(r.number::text, 6, '0'), 'subject', v_subject, 'org', v_org),
    'support_confirmation:' || r.id);

  return 'SR-' || lpad(r.number::text, 6, '0');
end $function$;

-- redefines ops.purge_deleted_orgs from 20261107235014_sms_operator_warnings.sql
create or replace function ops.purge_deleted_orgs()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_due uuid[];
  v_org uuid;
  v_requested timestamptz;
  v_tables text[];
  v_pending text[];
  v_next text[];
  t text;
  n int := 0;
begin
  select array_agg(c.table_name order by c.table_name) into v_tables
  from information_schema.columns c
  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
  where c.table_schema = 'app' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE';

  -- Read up front: the loop below alters tables, which fails while a cursor on them is open.
  -- Orgs whose storage files and device users are not gone yet are handed to purge-org first;
  -- the function reports back through api.mark_org_purged_externally and the next run purges.
  perform private.kick_purge_org(o.id) from app.organizations o
  where o.status = 'pending_deletion' and o.deletion_scheduled_for <= now() and o.external_purged_at is null;
  select coalesce(array_agg(id), '{}') into v_due from app.organizations
  where status = 'pending_deletion' and deletion_scheduled_for <= now() and external_purged_at is not null;
  foreach v_org in array v_due loop
    select deletion_requested_at into v_requested from app.organizations where id = v_org;
    begin -- one org's failure rolls back only that org and leaves the others to purge
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I disable trigger user', t);
    end loop;
    -- Foreign keys stay enforced: a table that still has children is retried after them.
    v_pending := v_tables;
    for i in 1..20 loop
      v_next := '{}';
      foreach t in array v_pending loop
        begin
          execute format('delete from app.%I where org_id = $1', t) using v_org;
        exception when foreign_key_violation then
          v_next := v_next || t;
        end;
      end loop;
      v_pending := v_next;
      exit when cardinality(v_pending) = 0;
    end loop;
    if cardinality(v_pending) > 0 then
      raise exception 'purge_incomplete' using detail = array_to_string(v_pending, ',');
    end if;
    delete from app.organizations where id = v_org;
    foreach t in array v_tables || 'organizations'::text loop
      execute format('alter table app.%I enable trigger user', t);
    end loop;
    insert into ops.org_deletion_log (org_id, requested_at) values (v_org, v_requested);
    n := n + 1;
    exception when others then
      raise warning 'purge_deleted_orgs: org % failed: %', v_org, sqlerrm;
    end;
  end loop;
  return n;
end $function$;

-- 8. What the remaining functions now do
comment on function private.entitlement(uuid, text) is
  'The org''s value for an entitlement key: its override in app.org_entitlements, else the default in '
  'app.entitlement_defaults, else null for an unknown key. The only place entitlements are resolved.';
comment on function private.is_blocked(uuid, text, text) is
  'Always false: the cross-business contact blocklist belonged to the hosted service. A business''s '
  'own block list is checked separately (app.blocked_identities).';
comment on function private.support_grant(uuid) is
  'Always all-null: support grants gave the hosted service''s operators access and nobody holds one '
  'here. Kept because private.has_role reads it.';
comment on function api.grant_support_access(uuid, text, int, text) is
  'Owner only: records a support grant (''read'' or ''act'', 1-72 hours) and returns it. Kept for old '
  'bundles; in this build a grant gives nobody access (see private.support_grant). A second live '
  'grant replaces the first. Raises permission_denied (42501) for anyone but an owner, invalid_input '
  'for a bad scope, hours or blank reason.';
comment on function api.reserve_send(uuid) is
  'Service role only (dispatcher): decides allowed, cap_reached, country_blocked or budget_reached '
  'for one paid send and counts it when allowed. The daily cap and monthly budget are the lower of '
  'the org''s own channel_limits and the deployment ceilings (messaging.* entitlements; young orgs '
  'get a lower daily ceiling).';
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros, currency} for a row the caller has claimed. A sent '
  'SMS or WhatsApp with no cost_micros is priced at segments (default 1) x the provider rate and '
  'marked cost_source estimate; a quoted cost is marked provider. A retryable failure is retried '
  'after 30 s, doubling each time; the sixth failed attempt, a non-retryable failure or gone marks '
  'it dead; gone for a push row also deletes its subscription, and for email or SMS suppresses the '
  'address (reason complaint when error_code is complaint, else bounce; unsubscribed is an org-only '
  'stop). suppressed with error_code quiet_hours is retried in 15 minutes. Reports for rows no '
  'longer claimed are ignored. Raises invalid_input, not_found.';
comment on function api.report_incident(uuid, text, text, text, timestamptz, text[], boolean, uuid) is
  'Admin or owner of the business: adds an entry to its incident log and returns the entry id. '
  'p_notify_platform is kept for old bundles and ignored. Repeating p_idempotency_key returns the '
  'same entry. Raises invalid_input for a bad kind, category, blank title or a detection time in '
  'the future, permission_denied (42501) for anyone who is not an admin of p_org_id.';
comment on function api.contact_support(uuid, text, text, jsonb) is
  'Any member of the org (staff and up, any org status, including suspended): files a support '
  'request and returns its reference (SR-000123). Stores the subject (1-120 chars, one line) and '
  'message (1-4000), and a whitelisted context: page path without query string or fragment, app '
  'version, browser, viewport, online state and last client error id from p_context, plus org name '
  'and role from the database. Nothing else in p_context is kept and no guest data is read. Queues '
  'an email to the support inbox and a confirmation to the requester through the outbox. The same '
  'words again within 60 s return the same reference and send nothing; more than 5 requests per '
  'person per hour raise rate_limited. Raises not_authenticated (42501), not_found for an org the '
  'caller is not a member of (including a revoked membership), invalid_input, rate_limited.';

notify pgrst, 'reload schema';
