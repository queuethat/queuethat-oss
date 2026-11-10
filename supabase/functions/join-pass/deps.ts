// The Supabase side of join-pass, built from whichever supabase-js the runtime has: index.ts
// passes Deno's npm import, the e2e suite passes Node's (CI runs Supabase without the edge runtime).
import { HostnameRefusedError, type JoinPassDeps } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string },
): Pick<JoinPassDeps, 'issue'> {
  const api = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('api');
  return {
    async issue(hostname) {
      const { data, error } = await api.rpc('issue_join_pass', { p_hostname: hostname });
      if (error?.message === 'captcha_required') throw new HostnameRefusedError(error.message);
      if (error || typeof data !== 'string') throw new Error(error?.message ?? 'no pass');
      return data;
    },
  };
}
