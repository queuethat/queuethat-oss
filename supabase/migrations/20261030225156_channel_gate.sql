-- 3-CG13 (#338): the database refuses to switch a provider channel on until the deployment and the org
-- meet every prerequisite. Replaces the api.set_channel_enabled stub from 20261030210404_api_contracts_3.sql.

-- One row, written only by the deploy runbook (docs/ops/pilot-runbook.md), never by the app.
create table app.platform_flags (
  singleton boolean primary key default true check (singleton),
  compliance_gate_passed_at timestamptz,
  hosted_legal_reviewed_at timestamptz
);
insert into app.platform_flags default values;
alter table app.platform_flags enable row level security;
-- Read only through private.channel_missing (definer); no tenant role reads or writes it.
create policy platform_flags_none on app.platform_flags for select to authenticated using (false);
revoke all on app.platform_flags from public, anon, authenticated;
grant select, update on app.platform_flags to service_role;

-- What an owner still has to do before this channel may be enabled; empty when nothing.
create function private.channel_missing(p_org_id uuid, p_channel text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  f app.platform_flags;
  s app.provider_settings;
  l app.channel_limits;
  missing text[] := '{}';
begin
  select * into f from app.platform_flags;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
  if f.compliance_gate_passed_at is null then missing := array_append(missing, 'compliance_gate'); end if;
  if not found then
    return array_append(missing, 'provider_settings');
  end if;
  if s.mode = 'platform' and f.hosted_legal_reviewed_at is null then missing := array_append(missing, 'hosted_legal_review'); end if;
  if s.verified_at is null then missing := array_append(missing, 'provider_verified'); end if;
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
end $$;
revoke all on function private.channel_missing(uuid, text) from public, anon, authenticated;

-- redefines api.set_channel_enabled from 20261030210404_api_contracts_3.sql
create or replace function api.set_channel_enabled(p_org_id uuid, p_channel text, p_enabled boolean, p_idempotency_key uuid)
returns api.channel_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  missing text[];
  s app.provider_settings;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from app.memberships m where m.user_id = uid and m.org_id = p_org_id) then
    raise exception 'not_found';
  end if;
  if not private.has_role(p_org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_enabled is null or p_channel is null
     or p_channel not in ('email', 'sms', 'whatsapp', 'payments') then
    raise exception 'invalid_input';
  end if;

  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel for update;
  if p_enabled then
    missing := private.channel_missing(p_org_id, p_channel);
    if cardinality(missing) > 0 then
      raise exception 'channel_prerequisite_missing' using detail = array_to_string(missing, ',');
    end if;
    update app.provider_settings set enabled = true, version = version + 1, updated_at = now()
    where id = s.id and not enabled;
    return (p_channel, true, '{}')::api.channel_status;
  end if;

  -- Switching off is always allowed and takes effect for rows still waiting in the outbox.
  if found then
    update app.provider_settings set enabled = false, version = version + 1, updated_at = now()
    where id = s.id and enabled;
  end if;
  update app.notifications set status = 'suppressed', error_code = 'channel_disabled'
  where org_id = p_org_id and channel::text = p_channel and status in ('queued', 'failed');
  return (p_channel, false, private.channel_missing(p_org_id, p_channel))::api.channel_status;
end $$;
comment on function api.set_channel_enabled(uuid, text, boolean, uuid) is
  'Owner only. Enabling needs the deployment compliance gate, the org''s verified provider settings and, for SMS, a daily cap, '
  'a country allowlist and (US) a campaign reference; otherwise raises channel_prerequisite_missing with the missing items '
  'in DETAIL (compliance_gate, hosted_legal_review, provider_settings, provider_verified, daily_cap, country_allowlist, '
  'campaign_ref). Disabling is always allowed, is idempotent and suppresses the channel''s waiting outbox rows '
  '(channel_disabled). Raises not_found for a non-member, permission_denied below owner, invalid_input.';

-- redefines api.set_provider_settings from 20261030214017_provider_settings.sql
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
  'Secrets named in p_secrets replace the stored ones; others are kept. Changing provider, mode or a secret clears '
  'verified_at and disables the channel. Never enables the channel. A repeat with the same idempotency key returns the '
  'current row. A messaging_campaign_ref key in p_config is stored in its own column. Raises not_found for a non-member, permission_denied for below admin, invalid_input, '
  'platform_mode_unavailable when mode = platform and the deployment has not set platform_messaging_enabled.';

-- redefines api.get_channel_config from 20261030214017_provider_settings.sql
create or replace function api.get_channel_config(p_org_id uuid, p_channel text) returns api.channel_config
language plpgsql stable security definer set search_path = '' as $$
declare
  s app.provider_settings;
begin
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel and enabled;
  -- the gate holds for as long as the channel is on, not only when it was switched on
  if not found or cardinality(private.channel_missing(p_org_id, p_channel)) > 0 then
    return (null, null, null, null, false)::api.channel_config;
  end if;
  return (s.provider, s.mode, s.config,
          (select coalesce(jsonb_object_agg(x.key, d.decrypted_secret), '{}')
           from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid),
          true)::api.channel_config;
end $$;
comment on function api.get_channel_config(uuid, text) is
  'Service role only (dispatcher): the org''s decrypted provider config for a channel, or a row with a null provider and '
  'enabled = false when the channel is not enabled or no longer meets its prerequisites (api.set_channel_enabled). Secrets must stay in function memory for one invocation.';


notify pgrst, 'reload schema';
