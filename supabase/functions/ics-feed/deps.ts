// The Supabase side of the feed, built from whichever supabase-js the runtime has (see unsubscribe/deps.ts).
import type { FeedDeps, FeedRow } from './handler.ts';

// deno-lint-ignore no-explicit-any
type CreateClient = (url: string, key: string, options: any) => any;

export function supabaseDeps(
  createClient: CreateClient,
  env: { url: string; serviceRoleKey: string },
): Pick<FeedDeps, 'events' | 'serviceNames'> {
  const client = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async events(token) {
      const { data, error } = await client.schema('api').rpc('calendar_feed_events', { p_token: token });
      if (error) {
        if (error.message === 'not_found') return null;
        throw new Error(error.message);
      }
      return (data ?? []) as FeedRow[];
    },
    async serviceNames(ids) {
      if (ids.length === 0) return new Map();
      const { data, error } = await client.schema('app').from('services').select('id, name').in('id', ids);
      if (error) throw new Error(error.message);
      return new Map((data ?? []).map((s: { id: string; name: string }) => [s.id, s.name]));
    },
  };
}
