-- Webhook endpoints can be edited and deleted, and owners hear when one is switched off for failing (#102).
-- Interface choice: (a) two siblings of rotate_webhook_secret (update + delete) and the owner email sent from
-- inside report_webhook_result, (b) a generic "manage endpoint" RPC plus a sweeper that mails disabled endpoints
-- later. (a) won: the disable and its email commit together, one failure run is one email, and each RPC states
-- its own errors. No Phase-0 stub existed for these (same as rotate_webhook_secret).
-- The email carries the endpoint host only, never the URL (a Slack or Teams URL is itself a credential).

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number',
                     'sms_paused', 'sms_paused_operator', 'sms_warning_operator', 'sms_digest_operator',
                     'incident_notice', 'incident_reported_operator', 'guest_incident_notice',
                     'waiver_records_expiring', 'member_verify', 'webhook_disabled'));

insert into app.notification_templates (trigger, channel, locale, category, subject, body) values
  ('webhook_disabled', 'email', 'en', 'transactional', '{org}: a webhook was switched off',
   'QueueThat stopped sending events to {host} for {org} because deliveries kept failing. '
   'Nothing else is affected. Fix the receiver, then turn the endpoint back on under Developers, Webhooks '
   'in your admin console (/admin/developers/webhooks).'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

create function api.update_webhook_endpoint(p_endpoint_id uuid, p_url text, p_event_types text[], p_include_guest_name boolean)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.webhook_endpoints;
begin
  select * into e from app.webhook_endpoints where id = p_endpoint_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = e.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(e.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_url is null or p_event_types is null or cardinality(p_event_types) = 0 or p_include_guest_name is null then
    raise exception 'invalid_input';
  end if;
  if p_url !~ '^https://[^@[:space:]]+$'
     and not (p_url ~ '^http://[^@[:space:]]+$' and (select d.allow_http_webhooks from private.deployment_settings d)) then
    raise exception 'invalid_url';
  end if;
  begin
    update app.webhook_endpoints
    set url = p_url, event_types = p_event_types, include_guest_name = p_include_guest_name,
        -- a new address starts with a clean record; the endpoint stays off until its owner turns it on
        consecutive_failures = case when p_url <> e.url then 0 else e.consecutive_failures end
    where id = e.id;
  exception when check_violation then
    raise exception 'invalid_input';
  end;
end $$;
comment on function api.update_webhook_endpoint(uuid, text, text[], boolean) is
  'Changes an endpoint''s URL, event types and guest-name opt-in (the format and signing secret stay). A new URL '
  'resets the failure count; deliveries still queued go to the new URL. Owner or admin of the whole org. Raises '
  'not_found, permission_denied, invalid_url (https only unless the deployment allows http), invalid_input.';

create function api.delete_webhook_endpoint(p_endpoint_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.webhook_endpoints;
begin
  select * into e from app.webhook_endpoints where id = p_endpoint_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = e.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(e.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  delete from app.webhook_endpoints where id = e.id;
end $$;
comment on function api.delete_webhook_endpoint(uuid) is
  'Deletes an endpoint with its delivery log and signing secrets (Vault). The audit log keeps the deletion. '
  'Owner or admin of the whole org. Raises not_found, permission_denied.';

revoke all on function api.update_webhook_endpoint(uuid, text, text[], boolean), api.delete_webhook_endpoint(uuid) from public, anon;
grant execute on function api.update_webhook_endpoint(uuid, text, text[], boolean), api.delete_webhook_endpoint(uuid)
  to authenticated, service_role;

-- redefines api.report_webhook_result from 20261030180428_webhook_sender_policy.sql
create or replace function api.report_webhook_result(p_delivery_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.webhook_deliveries;
  was_active boolean;
  now_active boolean;
  ok boolean := p_result ->> 'status' = 'delivered';
  retryable boolean := coalesce((p_result ->> 'retryable')::boolean, true);
begin
  select * into d from app.webhook_deliveries where id = p_delivery_id for update;
  if not found then raise exception 'not_found'; end if;
  -- a stale sender (lease expired and re-claimed, or already settled) changes nothing
  -- (a late report from a worker whose lease expired and was re-claimed carries an older attempt count)
  if d.status <> 'claimed' or (p_result ? 'attempt' and (p_result ->> 'attempt')::int is distinct from d.attempts) then return; end if;
  update app.webhook_deliveries
  set status = case when ok then 'delivered' when not retryable or d.attempts + 1 >= 8 then 'dead' else 'failed' end,
      attempts = d.attempts + 1, locked_until = null,
      next_attempt_at = now() + make_interval(secs => coalesce(greatest(least((p_result ->> 'retry_in_seconds')::bigint, 86400), 1),
                                                                 least(power(3, d.attempts)::int, 240) * 60)),
      response_status = (p_result ->> 'response_status')::int, response_ms = (p_result ->> 'response_ms')::int,
      error = left(p_result ->> 'error', 500)
  where id = d.id;
  -- Twenty dead deliveries in a row disable the endpoint; a retry that is still pending changes nothing.
  select e.active into was_active from app.webhook_endpoints e where e.id = d.endpoint_id for update;
  update app.webhook_endpoints e
  set consecutive_failures = case when ok then 0
        when not retryable or d.attempts + 1 >= 8 then e.consecutive_failures + 1 else e.consecutive_failures end,
      active = e.active and (ok or retryable and d.attempts + 1 < 8 or e.consecutive_failures + 1 < 20),
      disabled_reason = case when not ok and e.active and (not retryable or d.attempts + 1 >= 8)
                              and e.consecutive_failures + 1 >= 20 then 'too_many_failures' else e.disabled_reason end
  where e.id = d.endpoint_id
  returning e.active into now_active;
  -- Switched off by this report: the owners hear once (one email per owner and endpoint switch-off).
  if was_active and not now_active then
    perform private.enqueue_account_email(
      d.org_id, 'webhook_disabled',
      jsonb_build_object('org', (select o.name from app.organizations o where o.id = d.org_id),
                         'host', (select split_part(split_part(regexp_replace(e.url, '^https?://', ''), '/', 1), ':', 1)
                                  from app.webhook_endpoints e where e.id = d.endpoint_id)),
      'webhook_disabled:' || d.endpoint_id || ':' || extract(epoch from now())::bigint);
  end if;
end $$;
comment on function api.report_webhook_result(uuid, jsonb) is
  'Service role only: records an attempt {status: delivered|failed, response_status, response_ms, error, '
  'retryable, retry_in_seconds}. The sender sets retry_in_seconds (default 1, 3, 9 ... 240 minutes). The '
  'eighth failure, or a non-retryable one, is dead; 20 dead deliveries in a row disable the endpoint '
  '(disabled_reason too_many_failures) and its owners get one email. A delivery that is not claimed is left alone.';

notify pgrst, 'reload schema';
