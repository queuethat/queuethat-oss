// square-oauth entry point. The logic and its contract are in ../_shared/integration-oauth.ts.
// verify_jwt stays on (supabase/config.toml): only signed-in users get this far, and the database then decides
// whether they may connect an integration.
import { createClient } from '@supabase/supabase-js';
import { squareAuthorizeUrl, squareExchangeCode } from '@qm/providers';
import { createObserver } from '../_shared/observe.ts';
import { createIntegrationOAuthHandler, DbError } from '../_shared/integration-oauth.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const observe = createObserver('square-oauth', Deno.env.get('SENTRY_DSN'));
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), noSession);
// The caller's own JWT, so the RPC and RLS see them and not the service role.
const asCaller = (jwt: string) =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { ...noSession, global: { headers: { Authorization: `Bearer ${jwt}` } } });

Deno.serve(observe.serve(createIntegrationOAuthHandler({
  async userId(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    return error ? null : data.user?.id ?? null;
  },
  async begin(jwt, orgId) {
    const { data, error } = await asCaller(jwt).schema('api').rpc('begin_integration_connect', { p_org_id: orgId, p_channel: 'pos' });
    if (error) throw new DbError(error.message);
    return data as string;
  },
  async config(jwt, orgId) {
    const { data } = await asCaller(jwt).schema('app').from('provider_settings').select('config').eq('org_id', orgId).eq('channel', 'pos').maybeSingle();
    return (data?.config as Record<string, unknown> | undefined) ?? null;
  },
  async consume(state, userId) {
    const { data, error } = await admin.schema('api').rpc('consume_integration_state', { p_state: state, p_user_id: userId });
    if (error) throw new DbError(error.message);
    return data as never;
  },
  expect: { channel: 'pos', provider: 'square' },
  authorizeUrl: squareAuthorizeUrl,
  exchange: (config, secrets, code) => squareExchangeCode(config, secrets, code),
  async save(orgId, tokens) {
    const { error } = await admin.schema('api').rpc('save_integration_tokens', {
      p_org_id: orgId, p_channel: 'pos', p_secrets: tokens.secrets, p_config: tokens.config, p_verified: true,
    });
    if (error) throw new DbError(error.message);
  },
  log: observe.error,
})));
