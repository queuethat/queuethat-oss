// The Supabase side of unsubscribe, built from whichever supabase-js the runtime has: index.ts
// passes Deno's npm import, the e2e suite passes Node's (CI runs Supabase without the edge runtime).
import type { UnsubscribeDeps } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string },
): Pick<UnsubscribeDeps, 'unsubscribe'> {
  const api = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema('api');
  return {
    async unsubscribe(outboxId) {
      const { error } = await api.rpc('unsubscribe_outbox', { p_outbox_id: outboxId });
      if (error) throw new Error(error.message);
    },
  };
}
