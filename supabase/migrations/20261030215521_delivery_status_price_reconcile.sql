-- 3-SMS2 (#351): delivery status from provider callbacks, and the provider's real price for SMS
-- that were only estimated at send time. Expand only: nullable columns, new service-role functions.
alter table app.notifications
  add column delivery_status text check (delivery_status in ('queued', 'sent', 'delivered', 'undelivered', 'failed')),
  add column price_checked_at timestamptz;
grant select (delivery_status, price_checked_at) on app.notifications to authenticated;
comment on column app.notifications.delivery_status is
  'Last provider-reported delivery state. delivered, undelivered and failed are final; a late callback never moves them.';

-- Service role only (provider-webhook handler). Why a new function and not report_outbox_result:
-- that one settles a claimed send; callbacks arrive after it, for a row in any state.
create function api.apply_delivery_status(p_org_id uuid, p_provider text, p_provider_message_id text,
                                          p_status text, p_error_code text default null) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rank int := case p_status when 'queued' then 0 when 'sent' then 1 else 2 end;
  v_matched boolean;
begin
  if p_status is null or p_status not in ('queued', 'sent', 'delivered', 'undelivered', 'failed')
     or p_provider_message_id is null or p_org_id is null then
    raise exception 'invalid_input';
  end if;
  -- The org must own the message: a callback through another org's endpoint matches nothing.
  update app.notifications n set
    delivery_status = p_status,
    delivered_at = case when p_status = 'delivered' then coalesce(n.delivered_at, now()) else n.delivered_at end,
    error_code = coalesce(n.error_code, left(p_error_code, 100))
  where n.org_id = p_org_id and n.provider = p_provider and n.provider_message_id = p_provider_message_id
    and case coalesce(n.delivery_status, 'queued') when 'queued' then 0 when 'sent' then 1 else 2 end < v_rank
  returning true into v_matched;
  if v_matched then return true; end if;
  -- Not updated: either unknown here, or an older/duplicate callback for a row that is already past it.
  return exists (select 1 from app.notifications n
                 where n.org_id = p_org_id and n.provider = p_provider and n.provider_message_id = p_provider_message_id);
end $$;
comment on function api.apply_delivery_status(uuid, text, text, text, text) is
  'Service role only: records a provider delivery status (queued|sent|delivered|undelivered|failed) on the org''s message with that provider id. Final states never move backwards and a repeat changes nothing. Returns false when the org has no such message (nothing is written). Raises invalid_input.';
revoke all on function api.apply_delivery_status(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function api.apply_delivery_status(uuid, text, text, text, text) to service_role;

-- Up to p_limit sent SMS still on an estimated price: older than 10 minutes, younger than 48 hours
-- (after that we give up), least recently checked first so unpriced rows can't starve the rest.
create function api.pending_price_reconciliation(p_limit int default 100)
returns table (id uuid, org_id uuid, provider text, provider_message_id text)
language sql stable security definer set search_path = '' as $$
  select n.id, n.org_id, n.provider, n.provider_message_id
  from app.notifications n
  where n.channel = 'sms' and n.status = 'sent' and n.cost_source = 'estimate' and n.provider_message_id is not null
    and n.sent_at < now() - interval '10 minutes' and n.sent_at > now() - interval '48 hours'
    and (n.price_checked_at is null or n.price_checked_at < now() - interval '30 minutes')
  order by n.price_checked_at nulls first, n.sent_at
  limit least(greatest(p_limit, 1), 100)
$$;
comment on function api.pending_price_reconciliation(int) is
  'Service role only (reconcile-costs): sent SMS whose cost is still an estimate, 10 minutes to 48 hours old, at most 100.';
revoke all on function api.pending_price_reconciliation(int) from public, anon, authenticated;
grant execute on function api.pending_price_reconciliation(int) to service_role;

-- A null price only marks the row as checked (Twilio fills `price` later). Providers report
-- charges as negative numbers, so the sign is dropped: -0.0079 USD is 7900 micros.
create function api.apply_provider_price(p_org_id uuid, p_notification_id uuid, p_price numeric, p_currency text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update app.notifications n set
    price_checked_at = now(),
    cost_micros = case when p_price is null then n.cost_micros else round(abs(p_price) * 1000000)::bigint end,
    currency = case when p_price is null then n.currency else upper(left(coalesce(p_currency, n.currency), 3)) end,
    cost_source = case when p_price is null then n.cost_source else 'provider' end
  where n.id = p_notification_id and n.org_id = p_org_id and n.cost_source = 'estimate';
end $$;
comment on function api.apply_provider_price(uuid, uuid, numeric, text) is
  'Service role only (reconcile-costs): replaces an estimated cost with the provider''s price (absolute value, in micros) and marks it cost_source provider; a null price only records the check. Does nothing for another org''s message or one already priced.';
revoke all on function api.apply_provider_price(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function api.apply_provider_price(uuid, uuid, numeric, text) to service_role;

-- Every 10 minutes pg_cron asks reconcile-costs to run (vault secrets reconcile_costs_url and dispatcher_key).
create function ops.kick_reconcile_costs() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'reconcile_costs_url';
  if v_url is null then return; end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || coalesce(v_key, '')));
exception when others then
  raise warning 'kick_reconcile_costs failed: %', sqlerrm;
end $$;
comment on function ops.kick_reconcile_costs() is 'pg_cron every 10 minutes: POSTs to the reconcile-costs function. Never raises.';
revoke all on function ops.kick_reconcile_costs() from public, anon, authenticated;
select cron.schedule('reconcile-costs', '*/10 * * * *', 'select ops.kick_reconcile_costs()');
