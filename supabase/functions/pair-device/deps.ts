// D1 (#48): the Supabase side of pair-device, built from whichever supabase-js the runtime has.
// index.ts passes Deno's npm import; the e2e suite passes Node's, so browser tests run this
// exact code without the edge runtime (CI starts Supabase without it).
import { type DeviceClaim, type PairDeviceDeps, RateLimitedError } from './handler.ts';

/** The slice of supabase-js `createClient` this file uses. */
// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string; anonKey: string },
): Omit<PairDeviceDeps, 'log'> {
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.url, env.serviceRoleKey, noSession);
  const api = admin.schema('api');

  return {
    async redeem(code, clientKey) {
      const { data, error } = await api.rpc('redeem_pairing_code', {
        p_code: code,
        p_client_key: clientKey,
      });
      if (error?.message === 'rate_limited') throw new RateLimitedError();
      if (error) throw new Error(error.message);
      const claim = data as DeviceClaim | null;
      return claim?.device_id ? claim : null;
    },
    async createUser(email, password, appMetadata) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: appMetadata,
      });
      if (error || !data.user) throw new Error(error?.message ?? 'no user');
      return data.user.id;
    },
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(error.message);
    },
    async signIn(email, password) {
      // A fresh client per device: the session belongs to the device, not to this function.
      const client = createClient(env.url, env.anonKey, noSession);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.session) throw new Error(error?.message ?? 'no session');
      const { access_token, refresh_token, expires_in, expires_at, token_type } = data.session;
      return { access_token, refresh_token, expires_in, expires_at, token_type };
    },
    async registerDevice(deviceId, userId) {
      const { error } = await api.rpc('register_device', {
        p_device_id: deviceId,
        p_auth_user_id: userId,
      });
      if (error) throw new Error(error.message);
    },
  };
}
