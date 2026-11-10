-- #920: adapters build their delivery-report URL from the endpoint id, so api.get_channel_config
-- returns it inside config (the api.channel_config type is unchanged). The stored value is
-- overridden, so an org cannot plant a different endpoint_id through its own config.

-- redefines api.get_channel_config from 20261030225156_channel_gate.sql
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
  return (s.provider, s.mode, s.config || jsonb_build_object('endpoint_id', s.endpoint_id),
          (select coalesce(jsonb_object_agg(x.key, d.decrypted_secret), '{}')
           from jsonb_each(s.secret_ids) x join vault.decrypted_secrets d on d.id = (x.value #>> '{}')::uuid),
          true)::api.channel_config;
end $$;
comment on function api.get_channel_config(uuid, text) is
  'Service role only (dispatcher): the org''s decrypted provider config for a channel (config includes the webhook '
  'endpoint_id), or a row with a null provider and enabled = false when the channel is not enabled or no longer meets its '
  'prerequisites (api.set_channel_enabled). Secrets must stay in function memory for one invocation.';

notify pgrst, 'reload schema';
