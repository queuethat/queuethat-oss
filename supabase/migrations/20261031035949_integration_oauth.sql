-- 4-INT1 (#395) part 3: the OAuth hand-off shared by Square (#395) and HubSpot (#396).
-- api.begin_integration_connect (admin) mints a one-time state bound to the org, channel and user. The Edge Function
-- finishes the flow with api.consume_integration_state and api.save_integration_tokens (service role); a state is
-- stored only as sha256 and dies on first use. api.revoke_integration is the vendor-revoked path.
-- Interface rule 7, alternatives: (a) an unauthenticated vendor callback in the Edge Function, rejected: it cannot
-- tell which signed-in admin started the flow (login CSRF); (b) the vendor redirects to the SPA, which posts code and
-- state with the admin's JWT, and the function checks the state's user (chosen).

create table app.integration_oauth_states (
  state_hash bytea primary key,
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel text not null check (channel in ('pos', 'crm')),
  user_id uuid not null,
  expires_at timestamptz not null
);
alter table app.integration_oauth_states enable row level security;
create policy integration_oauth_states_select on app.integration_oauth_states for select to authenticated using (false);
revoke all on app.integration_oauth_states from public, anon, authenticated;

create function api.begin_integration_connect(p_org_id uuid, p_channel text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_state text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from app.memberships m where m.user_id = uid and m.org_id = p_org_id) then
    raise exception 'not_found';
  end if;
  if not private.is_org_admin_unrestricted(p_org_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('pos', 'crm')
     or not exists (select 1 from app.provider_settings s where s.org_id = p_org_id and s.channel = p_channel) then
    raise exception 'invalid_input';
  end if;
  delete from app.integration_oauth_states where expires_at < now() or (org_id = p_org_id and channel = p_channel);
  insert into app.integration_oauth_states (state_hash, org_id, channel, user_id, expires_at)
  values (extensions.digest(v_state, 'sha256'), p_org_id, p_channel, uid, now() + interval '10 minutes');
  return v_state;
end $$;
comment on function api.begin_integration_connect(uuid, text) is
  'Owner or admin: returns a one-time OAuth state (valid 10 minutes, bound to the caller, the org and the channel; '
  'only its hash is stored). Starting again replaces the earlier state. The org must have saved provider settings '
  'for the channel first. Raises not_authenticated, not_found for a non-member, permission_denied below admin, invalid_input.';

create type api.integration_credentials as (org_id uuid, channel text, provider text, config jsonb, secrets jsonb);

create function api.consume_integration_state(p_state text, p_user_id uuid) returns api.integration_credentials
language plpgsql volatile security definer set search_path = '' as $$
declare
  st app.integration_oauth_states;
  s app.provider_settings;
begin
  delete from app.integration_oauth_states where state_hash = extensions.digest(coalesce(p_state, ''), 'sha256')
  returning * into st;
  -- unknown, expired, used or someone else's state all answer alike
  if not found or st.expires_at < now() or st.user_id is distinct from p_user_id then
    raise exception 'not_found';
  end if;
  select * into s from app.provider_settings where org_id = st.org_id and channel = st.channel;
  if not found then raise exception 'not_found'; end if;
  return (s.org_id, s.channel, s.provider, s.config,
          (select coalesce(jsonb_object_agg(x.key, d.decrypted_secret), '{}')
           from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid))::api.integration_credentials;
end $$;
comment on function api.consume_integration_state(text, uuid) is
  'Service role only: spends a one-time OAuth state for the user the Edge Function authenticated and returns the '
  'connection''s decrypted credentials. Raises not_found for an unknown, expired, already used or foreign state.';

create function api.save_integration_tokens(p_org_id uuid, p_channel text, p_secrets jsonb, p_config jsonb, p_verified boolean)
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
  'Raises not_found, invalid_input.';

create function api.revoke_integration(p_org_id uuid, p_channel text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s app.provider_settings;
  gone text[] := array['access_token', 'refresh_token'];
begin
  select * into s from app.provider_settings where org_id = p_org_id and channel = p_channel and p_channel in ('pos', 'crm') for update;
  if not found then return; end if;
  delete from vault.secrets where id in (select (x.value #>> '{}')::uuid from jsonb_each(s.secret_ids) x where x.key = any (gone));
  update app.provider_settings
  set secret_ids = secret_ids - gone, secret_hints = secret_hints - gone, enabled = false, verified_at = null,
      version = version + 1, updated_at = now()
  where id = s.id;
  update app.integration_jobs set status = 'dead', error = 'revoked', locked_until = null
  where setting_id = s.id and status in ('queued', 'failed', 'claimed');
end $$;
comment on function api.revoke_integration(uuid, text) is
  'Service role only: the vendor revoked access. Deletes the OAuth tokens (the org''s own app credentials stay), '
  'disables and unverifies the connection and dead-letters its waiting jobs (revoked). A repeat or an unknown '
  'connection does nothing.';

revoke all on function api.consume_integration_state(text, uuid), api.save_integration_tokens(uuid, text, jsonb, jsonb, boolean),
  api.revoke_integration(uuid, text), api.begin_integration_connect(uuid, text) from public, anon, authenticated, service_role;
grant execute on function api.consume_integration_state(text, uuid), api.save_integration_tokens(uuid, text, jsonb, jsonb, boolean),
  api.revoke_integration(uuid, text) to service_role;
grant execute on function api.begin_integration_connect(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
