-- Platform Twilio SMS: an org in mode platform for sms/twilio sends through the deployment's own Twilio
-- sender (dispatcher env TWILIO_PLATFORM_*), so it has no credentials of its own to verify and no 10DLC
-- campaign of its own: the platform's registration covers it. Every other gate (paid plan, compliance
-- gate, hosted legal review, daily cap, country allowlist, prepaid credit) is unchanged.

-- redefines api.set_provider_settings from 20261031060634_integration_review_fixes.sql
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
  platform_sms boolean;
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

  -- The platform's own Twilio sender needs no test event of the org's and carries the platform's registration.
  platform_sms := p_mode = 'platform' and p_channel = 'sms' and p_provider = 'twilio';
  -- credentials or the provider changed: the last signed test event no longer proves anything
  changed := s.provider <> p_provider or s.mode <> p_mode or p_secrets <> '{}' or app_changed;
  update app.provider_settings
  set provider = p_provider, mode = p_mode, config = p_config,
      messaging_campaign_ref = case when platform_sms then 'platform' when v_keep_campaign then nullif(messaging_campaign_ref, 'platform') else nullif(v_campaign, 'platform') end,
      secret_ids = ids, secret_hints = hints,
      verified_at = case when platform_sms then coalesce(verified_at, now()) when changed then null else verified_at end,
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
  'set platform_messaging_enabled. Platform-mode SMS through twilio is verified and carries the platform''s campaign on save; '
  'enabling it still goes through api.set_channel_enabled and every gate there.';

-- redefines private.channel_missing from 20261031034758_plan_limits.sql
-- Adds platform_messaging (kill switch) and platform_requires_billing (platform SMS needs billing on).
create or replace function private.channel_missing(p_org_id uuid, p_channel text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  f app.platform_flags;
  s app.provider_settings;
  l app.channel_limits;
  missing text[] := '{}';
begin
  select * into f from app.platform_flags;
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel;
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
  -- Platform-paid SMS is only for billed orgs: with billing off nobody is charged for it.
  if s.mode = 'platform' and p_channel = 'sms' and not private.billing_enabled() then
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
end $$;
revoke all on function private.channel_missing(uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
