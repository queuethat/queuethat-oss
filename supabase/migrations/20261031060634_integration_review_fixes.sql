-- 4-INT1 (#395) review follow-ups L1, L4 and L6.
-- * L1: a revocation event names the merchant; it only revokes the connection of that merchant.
-- * L4: changing application_id or environment on a pos/crm connection invalidates everything the old app obtained
--   (tokens, verification, enabled, queued jobs), and the system-owned config keys survive an unrelated edit.
-- * L6: a token refresh (p_verified = false) never recreates tokens on a connection that has none (revoked meanwhile).

-- redefines api.revoke_integration from 20261031035949_integration_oauth.sql
drop function api.revoke_integration(uuid, text);
create function api.revoke_integration(p_org_id uuid, p_channel text, p_merchant_id text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.provider_settings;
  gone text[] := array['access_token', 'refresh_token'];
begin
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel and p_channel in ('pos', 'crm') for update;
  if not found then return; end if;
  -- an event for another merchant is not about this connection
  if p_merchant_id is not null and s.config ->> 'merchant_id' is not null and s.config ->> 'merchant_id' <> p_merchant_id then return; end if;
  delete from vault.secrets where id in (select (x.value #>> '{}')::uuid from jsonb_each(s.secret_ids) x where x.key = any (gone));
  update app.provider_settings
  set secret_ids = secret_ids - gone, secret_hints = secret_hints - gone, enabled = false, verified_at = null,
      version = version + 1, updated_at = now()
  where id = s.id;
  update app.integration_jobs set status = 'dead', error = 'revoked', locked_until = null
  where setting_id = s.id and status in ('queued', 'failed', 'claimed');
end $$;
comment on function api.revoke_integration(uuid, text, text) is
  'Service role only: the vendor revoked access. Deletes the OAuth tokens (the org''s own app credentials stay), '
  'disables and unverifies the connection and dead-letters its waiting jobs (revoked). With p_merchant_id, a '
  'connection that belongs to a different merchant is left alone. A repeat or an unknown connection does nothing.';
revoke all on function api.revoke_integration(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function api.revoke_integration(uuid, text, text) to service_role;

-- redefines api.save_integration_tokens from 20261031035949_integration_oauth.sql
create or replace function api.save_integration_tokens(p_org_id uuid, p_channel text, p_secrets jsonb, p_config jsonb, p_verified boolean)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.provider_settings;
  k text;
  v text;
  ids jsonb;
begin
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel and p_channel in ('pos', 'crm') for update;
  if not found then raise exception 'not_found'; end if;
  -- a refresh only replaces tokens that exist: after a revoke there is nothing to refresh
  if not coalesce(p_verified, false) and not s.secret_ids ? 'access_token' then return; end if;
  ids := s.secret_ids;
  for k, v in select e.key, e.value #>> '{}' from jsonb_each(coalesce(p_secrets, '{}')) e loop
    if k !~ '^[a-z0-9_]{1,32}$' or length(v) not between 1 and 4096 then raise exception 'invalid_input'; end if;
    if ids ? k then
      perform vault.update_secret((ids ->> k)::uuid, v);
    else
      ids := ids || jsonb_build_object(k, vault.create_secret(v, 'provider:' || s.id || ':' || k));
    end if;
  end loop;
  update app.provider_settings
  set secret_ids = ids, config = config || coalesce(p_config, '{}'),
      verified_at = case when p_verified then now() else verified_at end,
      version = version + 1, updated_at = now()
  where id = s.id;
end $$;
comment on function api.save_integration_tokens(uuid, text, jsonb, jsonb, boolean) is
  'Service role only: stores OAuth tokens in Vault (access_token, refresh_token ...), merges non-secret config '
  '(merchant_id, expires_at ...) and, when p_verified, marks the connection verified so an owner can enable it. '
  'Without p_verified (a refresh) it does nothing for a connection that has no tokens. Raises not_found, invalid_input.';

-- redefines api.set_provider_settings from 20261031033858_pos_crm_channels.sql
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
  app_changed boolean;
  v_campaign text;
  v_keep_campaign boolean;
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
  -- the 10DLC campaign reference is a column the gate reads, not free-form config
  v_campaign := case when p_config ? 'messaging_campaign_ref' then nullif(trim(p_config ->> 'messaging_campaign_ref'), '') end;
  v_keep_campaign := not (p_config ? 'messaging_campaign_ref');
  p_config := p_config - 'messaging_campaign_ref';
  p_secrets := coalesce(p_secrets, '{}');
  if p_idempotency_key is null or p_channel is null or p_provider is null or p_mode is null
     or jsonb_typeof(p_config) <> 'object' or jsonb_typeof(p_secrets) <> 'object'
     or p_channel not in ('email', 'sms', 'whatsapp', 'payments', 'llm', 'pos', 'crm') or p_provider !~ '^[a-z0-9_]{2,32}$'
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
  -- the vendor app (or its sandbox/production side) changed: nothing the old app obtained is valid any more
  app_changed := p_channel in ('pos', 'crm')
    and (p_config ->> 'application_id' is distinct from s.config ->> 'application_id'
         or p_config ->> 'environment' is distinct from s.config ->> 'environment');
  if p_channel in ('pos', 'crm') then
    if app_changed then
      delete from vault.secrets where id in (select (x.value #>> '{}')::uuid from jsonb_each(ids) x where x.key in ('access_token', 'refresh_token'));
      ids := ids - array['access_token', 'refresh_token'];
      hints := hints - array['access_token', 'refresh_token'];
      update app.integration_jobs set status = 'dead', error = 'revoked', locked_until = null
      where setting_id = s.id and status in ('queued', 'failed', 'claimed');
    else
      -- merchant_id and expires_at belong to the OAuth hand-off, not to the settings form
      p_config := p_config || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(s.config) e
                                        where e.key in ('merchant_id', 'expires_at')), '{}');
    end if;
  end if;
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
  changed := s.provider <> p_provider or s.mode <> p_mode or p_secrets <> '{}' or app_changed;
  update app.provider_settings
  set provider = p_provider, mode = p_mode, config = p_config,
      messaging_campaign_ref = case when v_keep_campaign then messaging_campaign_ref else v_campaign end, secret_ids = ids, secret_hints = hints,
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
  'Secrets named in p_secrets replace the stored ones; others are kept. Changing provider, mode, a secret or (pos, crm) the '
  'application_id or environment clears verified_at and disables the channel (and, for application_id or environment, drops the '
  'OAuth tokens and dead-letters waiting jobs). Never enables the channel. A repeat with the same idempotency key returns the '
  'current row. A messaging_campaign_ref key in p_config is stored in its own column. Raises not_found for a non-member, '
  'permission_denied for below admin, invalid_input, platform_mode_unavailable when mode = platform and the deployment has not '
  'set platform_messaging_enabled.';

notify pgrst, 'reload schema';
