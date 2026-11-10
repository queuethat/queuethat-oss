-- 3-PV1 (#340): per-org provider settings; credentials live in Vault and only the service role reads them back.
-- Replaces the api.set_provider_settings, get_channel_config and get_webhook_secret stubs from
-- 20261030210404_api_contracts_3.sql. Enabling a channel is 3-CG13 (#338), never this RPC.

alter table private.deployment_settings add column platform_messaging_enabled boolean not null default false;

create table app.provider_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'payments')),
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  mode text not null check (mode in ('own', 'platform')),
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 4096),
  secret_ids jsonb not null default '{}',
  secret_hints jsonb not null default '{}',
  endpoint_id uuid not null unique default gen_random_uuid(),
  messaging_campaign_ref text,
  verified_at timestamptz,
  enabled boolean not null default false,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (org_id, channel)
);
create trigger forbid_org_change before update on app.provider_settings
  for each row execute function private.forbid_org_change();
alter table app.provider_settings enable row level security;
create policy provider_settings_select on app.provider_settings for select to authenticated
  using ((select private.is_org_admin_unrestricted(org_id)));
revoke all on app.provider_settings from public, anon, authenticated;
grant select (id, org_id, channel, provider, mode, config, secret_hints, endpoint_id, messaging_campaign_ref,
              verified_at, enabled, version, updated_at) on app.provider_settings to authenticated;

-- audit_row minus the Vault ids
create function private.audit_provider_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  -- rows removed by an org cascade have nowhere to be logged
  if tg_op = 'DELETE' and not exists (select 1 from app.organizations where id = old.org_id) then
    return null;
  end if;
  insert into app.audit_log (org_id, actor, role, action, table_name, row_id, before, after)
  values (coalesce(new.org_id, old.org_id), uid,
          coalesce((select m.role::text from app.memberships m
                    where m.user_id = uid and m.org_id = coalesce(new.org_id, old.org_id)), 'system'),
          tg_op, tg_table_name, coalesce(new.id, old.id)::text,
          case when tg_op <> 'INSERT' then to_jsonb(old) - 'secret_ids' end,
          case when tg_op <> 'DELETE' then to_jsonb(new) - 'secret_ids' end);
  return null;
end $$;
revoke all on function private.audit_provider_settings() from public, anon, authenticated;
create trigger audit_provider_settings after insert or update or delete on app.provider_settings
  for each row execute function private.audit_provider_settings();

-- Vault secrets go with their settings row (and with the org, through the cascade)
create function private.drop_provider_secrets() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id in (select (v.value #>> '{}')::uuid from jsonb_each(old.secret_ids) v);
  return old;
end $$;
revoke all on function private.drop_provider_secrets() from public, anon, authenticated;
create trigger drop_provider_secrets before delete on app.provider_settings
  for each row execute function private.drop_provider_secrets();

-- redefines api.set_provider_settings from 20261030210404_api_contracts_3.sql
create or replace function api.set_provider_settings(p_org_id uuid, p_channel text, p_provider text, p_mode text, p_config jsonb,
                                          p_secrets jsonb, p_idempotency_key uuid)
returns api.provider_settings_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  s app.provider_settings;
  k text;
  v text;
  vid uuid;
  ids jsonb;
  hints jsonb;
  changed boolean;
  result api.provider_settings_row;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from app.memberships m where m.user_id = uid and m.org_id = p_org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(p_org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  p_config := coalesce(p_config, '{}');
  p_secrets := coalesce(p_secrets, '{}');
  if p_idempotency_key is null or p_channel is null or p_provider is null or p_mode is null
     or jsonb_typeof(p_config) <> 'object' or jsonb_typeof(p_secrets) <> 'object'
     or p_channel not in ('email', 'sms', 'whatsapp', 'payments') or p_provider !~ '^[a-z0-9_]{2,32}$'
     or p_mode not in ('own', 'platform') or (p_mode = 'platform' and p_secrets <> '{}') then
    raise exception 'invalid_input';
  end if;
  if p_mode = 'platform' and not (select d.platform_messaging_enabled from private.deployment_settings d) then
    raise exception 'platform_mode_unavailable';
  end if;

  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, uid, 'set_provider_settings', p_idempotency_key) on conflict do nothing;
  if not found then
    -- a repeat with the same key: return the current row, change nothing
    select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
    if not found then raise exception 'invalid_input'; end if;
    return (s.org_id, s.channel, s.provider, s.mode, s.config, s.secret_hints, s.endpoint_id,
            s.messaging_campaign_ref, s.verified_at, s.enabled, s.version)::api.provider_settings_row;
  end if;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel for update;
  if not found then
    insert into app.provider_settings (org_id, channel, provider, mode, config, version)
    values (p_org_id, p_channel, p_provider, p_mode, '{}', 0) returning * into s;
  end if;
  ids := s.secret_ids;
  hints := s.secret_hints;
  -- a different provider or mode starts from scratch: old credentials are dropped, not reused
  if s.provider <> p_provider or s.mode <> p_mode then
    delete from vault.secrets where id in (select (x.value #>> '{}')::uuid from jsonb_each(ids) x);
    ids := '{}';
    hints := '{}';
  end if;
  for k, v in select e.key, e.value #>> '{}' from jsonb_each(p_secrets) e loop
    if k !~ '^[a-z0-9_]{1,32}$' or jsonb_typeof(p_secrets -> k) <> 'string' or length(v) not between 1 and 4096 then
      raise exception 'invalid_input';
    end if;
    if ids ? k then
      perform vault.update_secret((ids ->> k)::uuid, v);
    else
      vid := vault.create_secret(v, 'provider:' || s.id || ':' || k);
      ids := ids || jsonb_build_object(k, vid);
    end if;
    -- a short secret would be shown almost whole, so it gets no hint
    hints := hints || jsonb_build_object(k, case when length(v) >= 12 then right(v, 4) else '' end);
  end loop;

  -- credentials or the provider changed: the last signed test event no longer proves anything
  changed := s.provider <> p_provider or s.mode <> p_mode or p_secrets <> '{}';
  update app.provider_settings
  set provider = p_provider, mode = p_mode, config = p_config, secret_ids = ids, secret_hints = hints,
      verified_at = case when changed then null else verified_at end,
      enabled = case when changed then false else enabled end,
      version = version + 1, updated_at = now()
  where id = s.id returning * into s;
  update app.idempotency_keys set response = jsonb_build_object('id', s.id)
  where actor_id = uid and rpc = 'set_provider_settings' and key = p_idempotency_key;
  return (s.org_id, s.channel, s.provider, s.mode, s.config, s.secret_hints, s.endpoint_id,
          s.messaging_campaign_ref, s.verified_at, s.enabled, s.version)::api.provider_settings_row;
end $$;
comment on function api.set_provider_settings(uuid, text, text, text, jsonb, jsonb, uuid) is
  'Owner or admin: saves non-secret config and stores secrets in Vault (only ids and last four characters are readable). '
  'Secrets named in p_secrets replace the stored ones; others are kept. Changing provider, mode or a secret clears '
  'verified_at and disables the channel. Never enables the channel. A repeat with the same idempotency key returns the '
  'current row. Raises not_found for a non-member, permission_denied for below admin, invalid_input, '
  'platform_mode_unavailable when mode = platform and the deployment has not set platform_messaging_enabled.';

-- redefines api.get_channel_config from 20261030210404_api_contracts_3.sql
create or replace function api.get_channel_config(p_org_id uuid, p_channel text) returns api.channel_config
language plpgsql stable security definer set search_path = '' as $$
declare
  s app.provider_settings;
begin
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel and enabled;
  if not found then
    return (null, null, null, null, false)::api.channel_config;
  end if;
  return (s.provider, s.mode, s.config,
          (select coalesce(jsonb_object_agg(x.key, d.decrypted_secret), '{}')
           from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid),
          true)::api.channel_config;
end $$;
comment on function api.get_channel_config(uuid, text) is
  'Service role only (dispatcher): the org''s decrypted provider config for a channel, or a row with a null provider and '
  'enabled = false when the channel is not enabled. Secrets must stay in function memory for one invocation.';

-- redefines api.get_webhook_secret from 20261030210404_api_contracts_3.sql
create or replace function api.get_webhook_secret(p_provider text, p_endpoint_id uuid) returns api.webhook_secret
language plpgsql stable security definer set search_path = '' as $$
declare
  s app.provider_settings;
begin
  select * into s from app.provider_settings where endpoint_id = p_endpoint_id and provider = p_provider;
  if not found then raise exception 'not_found'; end if;
  -- shape provider-webhook expects: {signing: [newest first, then *_prev], verify_token?}
  return (s.org_id, s.channel,
          (select jsonb_build_object('signing', coalesce(jsonb_agg(d.decrypted_secret order by x.key like '%\_prev', x.key)
                                                         filter (where x.key ~ '^(auth_token|signing_secret|webhook_secret|app_secret)(_prev)?$'), '[]'))
                  || coalesce(jsonb_object_agg('verify_token', d.decrypted_secret) filter (where x.key = 'verify_token'), '{}')
           from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid))::api.webhook_secret;
end $$;
comment on function api.get_webhook_secret(text, uuid) is
  'Service role only (provider-webhook): secrets as {signing: [..], verify_token?} (signing = auth_token, signing_secret, webhook_secret or app_secret, newest first) for one endpoint, even before '
  'the channel is enabled (the first signed test event is what verifies it). Raises not_found for an unknown endpoint '
  'or a provider that does not match it.';

notify pgrst, 'reload schema';
