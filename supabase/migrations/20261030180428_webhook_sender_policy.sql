-- 2B-I7 (#312): the sender owns the backoff schedule (retry_in_seconds), eight attempts, and the endpoint
-- is disabled after 20 dead deliveries in a row.
-- redefines api.claim_webhook_deliveries from 20261030174831_webhooks.sql
create or replace function api.claim_webhook_deliveries(p_limit int, p_lease_seconds int) returns setof api.webhook_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200 or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;
  update app.webhook_deliveries set status = 'dead', error = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= 8;
  return query
  with due as (
    select d.id from app.webhook_deliveries d join app.webhook_endpoints e on e.id = d.endpoint_id
    where e.active and ((d.status in ('queued', 'failed') and d.next_attempt_at <= now())
                        or (d.status = 'claimed' and d.locked_until < now()))
    order by d.next_attempt_at limit p_limit for update of d skip locked
  ), claimed as (
    update app.webhook_deliveries d
    set status = 'claimed', locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = d.attempts + case when d.status = 'claimed' then 1 else 0 end
    from due where d.id = due.id returning d.*
  )
  select c.id, e.url, e.kind, c.event_type, c.payload,
         -- during a rotation overlap the sender signs with both secrets (comma separated)
         concat_ws(',', (select s.decrypted_secret from vault.decrypted_secrets s where s.id = e.vault_secret_id),
                   case when e.prev_secret_expires_at > now() then
                     (select s.decrypted_secret from vault.decrypted_secrets s where s.id = e.prev_vault_secret_id) end),
         c.attempts
  from claimed c join app.webhook_endpoints e on e.id = c.endpoint_id;
end $$;
-- redefines api.report_webhook_result from 20261030174831_webhooks.sql
create or replace function api.report_webhook_result(p_delivery_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.webhook_deliveries;
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
  update app.webhook_endpoints e
  set consecutive_failures = case when ok then 0
        when not retryable or d.attempts + 1 >= 8 then e.consecutive_failures + 1 else e.consecutive_failures end,
      active = e.active and (ok or retryable and d.attempts + 1 < 8 or e.consecutive_failures + 1 < 20),
      disabled_reason = case when not ok and e.active and (not retryable or d.attempts + 1 >= 8)
                              and e.consecutive_failures + 1 >= 20 then 'too_many_failures' else e.disabled_reason end
  where e.id = d.endpoint_id;
end $$;
comment on function api.report_webhook_result(uuid, jsonb) is
  'Service role only: records an attempt {status: delivered|failed, response_status, response_ms, error, '
  'retryable, retry_in_seconds}. The sender sets retry_in_seconds (default 1, 3, 9 ... 240 minutes). The '
  'eighth failure, or a non-retryable one, is dead; 20 dead deliveries in a row disable the endpoint '
  '(disabled_reason too_many_failures). A delivery that is not claimed is left alone.';
