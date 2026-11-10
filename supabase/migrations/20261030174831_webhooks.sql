-- 2B-I6 (#311): outgoing webhooks. Endpoints and a delivery outbox filled in the event's own
-- transaction (same pattern as notifications). Signing secrets live in Vault because the sender must
-- read them. Payloads are minimal: no phone or email, a guest first name only if the endpoint opts in.
-- Replaces the api.create_webhook_endpoint, claim_webhook_deliveries and report_webhook_result stubs.
-- Adds api.rotate_webhook_secret and api.redeliver_webhook (no stub existed; both are owner/admin
-- actions the UI ticket #313 needs, and a sibling of create_webhook_endpoint, not a new surface).

alter table private.deployment_settings add column allow_http_webhooks boolean not null default false;

-- Owner or admin whose membership covers every location. A location-restricted admin must not
-- manage org-wide endpoints or read their payloads (they carry every location's events).
create function private.is_org_admin_unrestricted(p_org_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org_id, null, 'admin') and exists (
    select 1 from app.memberships m
    where m.user_id = (select auth.uid()) and m.org_id = p_org_id and m.role >= 'admin' and m.location_ids is null)
$$;
revoke all on function private.is_org_admin_unrestricted(uuid) from public, anon;
grant execute on function private.is_org_admin_unrestricted(uuid) to authenticated, service_role;

create table app.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  url text not null check (length(url) <= 2048 and url ~ '^https?://[^@[:space:]]+$'),
  kind text not null default 'generic' check (kind in ('generic', 'slack', 'discord', 'teams')),
  event_types text[] not null check (
    cardinality(event_types) > 0
    and event_types <@ array['visit.joined', 'visit.called', 'visit.recalled', 'visit.serving', 'visit.served',
      'visit.no_show', 'visit.cancelled', 'visit.removed', 'visit.requeued', 'visit.expired',
      'visit.reinstated', 'visit.checked_in', 'queue.state_changed']::text[]),
  include_guest_name boolean not null default false,
  vault_secret_id uuid not null,
  prev_vault_secret_id uuid,
  prev_secret_expires_at timestamptz,
  active boolean not null default true,
  consecutive_failures int not null default 0,
  disabled_reason text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index webhook_endpoints_org_idx on app.webhook_endpoints (org_id) where active;
create trigger forbid_org_change before update on app.webhook_endpoints
  for each row execute function private.forbid_org_change();
alter table app.webhook_endpoints enable row level security;
create policy webhook_endpoints_select on app.webhook_endpoints for select to authenticated
  using ((select private.is_org_admin_unrestricted(org_id)));
revoke all on app.webhook_endpoints from public, anon, authenticated;
grant select (id, org_id, url, kind, event_types, include_guest_name, active, consecutive_failures,
              disabled_reason, created_by, created_at) on app.webhook_endpoints to authenticated;
-- audit_row minus the Vault ids
create function private.audit_webhook_endpoint() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  k text[] := array['vault_secret_id', 'prev_vault_secret_id'];
begin
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, before, after)
  values (coalesce(new.org_id, old.org_id), uid,
          coalesce((select m.role::text from app.memberships m
                    where m.user_id = uid and m.org_id = coalesce(new.org_id, old.org_id)), 'system'),
          tg_op, tg_table_name, coalesce(new.id, old.id)::text,
          case when tg_op <> 'INSERT' then to_jsonb(old) - k end,
          case when tg_op <> 'DELETE' then to_jsonb(new) - k end);
  return null;
end $$;
revoke all on function private.audit_webhook_endpoint() from public, anon, authenticated;
create trigger audit_webhook_endpoint after insert or update or delete on app.webhook_endpoints
  for each row execute function private.audit_webhook_endpoint();

-- Vault secrets go with their endpoint
create function private.drop_webhook_secrets() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id in (old.vault_secret_id, old.prev_vault_secret_id);
  return old;
end $$;
revoke all on function private.drop_webhook_secrets() from public, anon, authenticated;
create trigger drop_webhook_secrets before delete on app.webhook_endpoints
  for each row execute function private.drop_webhook_secrets();

create table app.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  endpoint_id uuid not null references app.webhook_endpoints (id) on delete cascade,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'delivered', 'failed', 'dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  response_status int,
  response_ms int,
  error text,
  created_at timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
create index webhook_deliveries_due_idx on app.webhook_deliveries (next_attempt_at)
  where status in ('queued', 'failed', 'claimed');
create index webhook_deliveries_org_idx on app.webhook_deliveries (org_id, created_at desc);
create trigger forbid_org_change before update on app.webhook_deliveries
  for each row execute function private.forbid_org_change();
alter table app.webhook_deliveries enable row level security;
create policy webhook_deliveries_select on app.webhook_deliveries for select to authenticated
  using ((select private.is_org_admin_unrestricted(org_id)));
revoke all on app.webhook_deliveries from public, anon, authenticated;
grant select on app.webhook_deliveries to authenticated;

------------------------------------------------------------------------------------------------
-- Enqueue: same transaction as the event
------------------------------------------------------------------------------------------------

create function private.kick_webhooks() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if current_setting('app.webhooks_kicked', true) = 'on' then return; end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'webhook_sender_url';
  if v_url is null then return; end if;
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'dispatcher_key';
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || coalesce(v_key, '')));
  perform set_config('app.webhooks_kicked', 'on', true);
exception when others then
  raise warning 'kick_webhooks failed: %', sqlerrm;
end $$;
comment on function private.kick_webhooks() is
  'Asks pg_net to POST to the deliver-webhooks function after commit (vault secret webhook_sender_url). Never raises.';

create function private.enqueue_webhooks(p_org_id uuid, p_event_id text, p_event_type text, p_occurred_at timestamptz,
                                         p_visit_id uuid, p_data jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.webhook_endpoints e where e.org_id = p_org_id and e.active
                 and p_event_type = any (e.event_types)) then
    return;
  end if;
  insert into app.webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload)
  select e.org_id, e.id, p_event_id, p_event_type,
         jsonb_build_object('id', p_event_id, 'type', p_event_type, 'api_version', 'v1',
                            'occurred_at', p_occurred_at,
                            'data', p_data || case when e.include_guest_name and p_visit_id is not null then
                              jsonb_build_object('visit', p_data -> 'visit' || jsonb_build_object('guest_first_name',
                                (select nullif(split_part(btrim(v.guest_name), ' ', 1), '') from app.visits v where v.id = p_visit_id)))
                              else '{}'::jsonb end)
  from app.webhook_endpoints e
  where e.org_id = p_org_id and e.active and p_event_type = any (e.event_types)
  on conflict (endpoint_id, event_id) do nothing;
  perform private.kick_webhooks();
end $$;
comment on function private.enqueue_webhooks(uuid, text, text, timestamptz, uuid, jsonb) is
  'One queued delivery per active endpoint subscribed to the event type, in the caller''s transaction. '
  'The payload carries no contact data; guest_first_name only for endpoints that opted in.';

create function private.webhook_visit_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t text := case new.type when 'joined' then 'visit.joined' when 'call' then 'visit.called'
    when 'recall' then 'visit.recalled' when 'start' then 'visit.serving' when 'complete' then 'visit.served'
    when 'no_show' then 'visit.no_show' when 'cancel' then 'visit.cancelled' when 'remove' then 'visit.removed'
    when 'requeue' then 'visit.requeued' when 'expire' then 'visit.expired' when 'reinstate' then 'visit.reinstated'
    when 'check_in' then 'visit.checked_in' end;
begin
  if t is not null then
    perform private.enqueue_webhooks(new.org_id, 'v:' || new.id, t, new.occurred_at, new.visit_id,
      jsonb_build_object('visit', to_jsonb(private.v1_visit(new.visit_id))));
  end if;
  return null;
end $$;
create trigger webhook_visit_event after insert on app.visit_events
  for each row execute function private.webhook_visit_event();

create function private.webhook_queue_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.enqueue_webhooks(new.org_id, 'q:' || new.id || ':' || new.version, 'queue.state_changed', now(), null,
    jsonb_build_object('queue', jsonb_build_object('id', new.id, 'location_id', new.location_id, 'name', new.name,
                                                   'state', new.manual_state)));
  return null;
end $$;
create trigger webhook_queue_state after update on app.queues
  for each row when (old.manual_state is distinct from new.manual_state)
  execute function private.webhook_queue_state();

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

create function private.new_webhook_secret(p_endpoint_id uuid, out secret text, out vault_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
begin
  secret := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
  vault_id := vault.create_secret(secret, 'webhook:' || p_endpoint_id || ':' || gen_random_uuid());
end $$;

-- redefines api.create_webhook_endpoint from 20261030162713_api_contracts_2b.sql
create or replace function api.create_webhook_endpoint(p_org_id uuid, p_url text, p_kind text, p_event_types text[],
                                                       p_include_guest_name boolean, p_idempotency_key uuid)
returns api.webhook_endpoint_created
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result api.webhook_endpoint_created;
  s record;
  v_id uuid := gen_random_uuid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from app.memberships m where m.user_id = uid and m.org_id = p_org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(p_org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_url is null or p_kind is null or p_event_types is null
     or cardinality(p_event_types) = 0 then
    raise exception 'invalid_input';
  end if;
  if p_url !~ '^https://[^@[:space:]]+$'
     and not (p_url ~ '^http://[^@[:space:]]+$' and (select d.allow_http_webhooks from private.deployment_settings d)) then
    raise exception 'invalid_url';
  end if;
  if p_kind not in ('generic', 'slack', 'discord', 'teams')
     or (select count(*) from app.webhook_endpoints e where e.org_id = p_org_id) >= 10 then
    raise exception 'invalid_input';
  end if;

  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, uid, 'create_webhook_endpoint', p_idempotency_key) on conflict do nothing;
  if not found then
    select r.id, null::text into result
    from app.idempotency_keys k, lateral jsonb_populate_record(null::api.webhook_endpoint_created, k.response) r
    where k.actor_id = uid and k.rpc = 'create_webhook_endpoint' and k.key = p_idempotency_key and k.org_id = p_org_id;
    return result;
  end if;

  select * into s from private.new_webhook_secret(v_id);
  begin
    insert into app.webhook_endpoints (id, org_id, url, kind, event_types, include_guest_name, vault_secret_id, created_by)
    values (v_id, p_org_id, p_url, p_kind, p_event_types, coalesce(p_include_guest_name, false), s.vault_id, uid);
  exception when check_violation then
    raise exception 'invalid_input';
  end;
  result := (v_id, s.secret);
  update app.idempotency_keys set response = jsonb_build_object('id', v_id)
  where actor_id = uid and rpc = 'create_webhook_endpoint' and key = p_idempotency_key;
  return result;
end $$;
comment on function api.create_webhook_endpoint(uuid, text, text, text[], boolean, uuid) is
  'Registers a webhook endpoint and returns its signing secret once (a repeat with the same idempotency '
  'key returns the id and a null secret). Owner or admin. Raises not_found for a non-member, '
  'permission_denied for a manager or staff, invalid_url unless the URL is https (http only when the '
  'deployment allows it), invalid_input for an unknown kind or event type.';

create function api.rotate_webhook_secret(p_endpoint_id uuid) returns api.webhook_endpoint_created
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.webhook_endpoints;
  s record;
begin
  select * into e from app.webhook_endpoints where id = p_endpoint_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = e.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(e.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into s from private.new_webhook_secret(e.id);
  delete from vault.secrets where id = e.prev_vault_secret_id;
  update app.webhook_endpoints
  set vault_secret_id = s.vault_id, prev_vault_secret_id = e.vault_secret_id,
      prev_secret_expires_at = now() + interval '24 hours'
  where id = e.id;
  return (e.id, s.secret)::api.webhook_endpoint_created;
end $$;
comment on function api.rotate_webhook_secret(uuid) is
  'Issues a new signing secret (shown once). The old one keeps signing alongside it for 24 hours. '
  'Owner or admin. Raises not_found, permission_denied.';

create function api.redeliver_webhook(p_delivery_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.webhook_deliveries;
begin
  select * into d from app.webhook_deliveries where id = p_delivery_id for update;
  if not found or not exists (select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = d.org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(d.org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if d.status in ('delivered', 'failed', 'dead') then
    update app.webhook_deliveries set status = 'queued', attempts = 0, next_attempt_at = now(), error = null
    where id = d.id;
    perform private.kick_webhooks();
  end if;
end $$;
comment on function api.redeliver_webhook(uuid) is
  'Queues a delivery again from the start (an endpoint owner replaying a missed event). A delivery '
  'still in flight is left alone. Owner or admin. Raises not_found, permission_denied.';

-- redefines api.claim_webhook_deliveries from 20261030162713_api_contracts_2b.sql
create or replace function api.claim_webhook_deliveries(p_limit int, p_lease_seconds int) returns setof api.webhook_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200 or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;
  update app.webhook_deliveries set status = 'dead', error = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= 6;
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
comment on function api.claim_webhook_deliveries(int, int) is
  'Service role only: leases up to p_limit due deliveries for p_lease_seconds with the endpoint URL, kind, '
  'payload and signing secret(s) (two, comma separated, while a rotated secret is still valid). '
  'Concurrent senders never receive the same row.';

-- redefines api.report_webhook_result from 20261030162713_api_contracts_2b.sql
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
  if d.status <> 'claimed' then return; end if;
  update app.webhook_deliveries
  set status = case when ok then 'delivered' when not retryable or d.attempts + 1 >= 6 then 'dead' else 'failed' end,
      attempts = d.attempts + 1, locked_until = null,
      next_attempt_at = now() + make_interval(mins => least(power(3, d.attempts)::int, 240)),
      response_status = (p_result ->> 'response_status')::int, response_ms = (p_result ->> 'response_ms')::int,
      error = left(p_result ->> 'error', 500)
  where id = d.id;
  update app.webhook_endpoints e
  set consecutive_failures = case when ok then 0 else e.consecutive_failures + 1 end,
      active = e.active and (ok or e.consecutive_failures + 1 < 50),
      disabled_reason = case when not ok and e.active and e.consecutive_failures + 1 >= 50 then 'too_many_failures' else e.disabled_reason end
  where e.id = d.endpoint_id;
end $$;
comment on function api.report_webhook_result(uuid, jsonb) is
  'Service role only: records an attempt {status: delivered|failed, response_status, response_ms, error, '
  'retryable}. Failures back off (1, 3, 9 ... up to 240 minutes) and the sixth becomes dead; 50 failures '
  'in a row disable the endpoint (disabled_reason too_many_failures).';

revoke all on function api.rotate_webhook_secret(uuid), api.redeliver_webhook(uuid) from public, anon;
grant execute on function api.rotate_webhook_secret(uuid), api.redeliver_webhook(uuid) to authenticated, service_role;
revoke all on function private.kick_webhooks(), private.enqueue_webhooks(uuid, text, text, timestamptz, uuid, jsonb),
  private.webhook_visit_event(), private.webhook_queue_state(), private.new_webhook_secret(uuid) from public, anon, authenticated;

create function ops.purge_webhook_deliveries() returns int
language sql volatile security definer set search_path = '' as $$
  with d as (delete from app.webhook_deliveries where created_at < now() - interval '30 days' returning 1)
  select count(*)::int from d
$$;
revoke all on function ops.purge_webhook_deliveries() from public, anon, authenticated;
select cron.schedule('purge-webhook-deliveries', '29 3 * * *', 'select ops.purge_webhook_deliveries()');
create function ops.kick_webhooks_if_due() returns void
language sql volatile security definer set search_path = '' as $$
  select private.kick_webhooks() where exists (
    select 1 from app.webhook_deliveries d where d.status in ('queued', 'failed') and d.next_attempt_at <= now())
$$;
revoke all on function ops.kick_webhooks_if_due() from public, anon, authenticated;
select cron.schedule('kick-webhooks', '* * * * *', 'select ops.kick_webhooks_if_due()');

notify pgrst, 'reload schema';
