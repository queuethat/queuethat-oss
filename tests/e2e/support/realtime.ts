import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { supabaseEnv } from './env.ts';

/** The local Supabase database as its superuser, which owns Realtime's tenant table. */
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

/** A Supabase client for `token`, or for anon when it's null, that never stores a session. */
export function realtimeClient(token: string | null = null): SupabaseClient {
  const { url, anonKey } = supabaseEnv();
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (token) void client.realtime.setAuth(token);
  return client;
}

/**
 * Subscribes to `topic` and resolves with how the join ended: 'SUBSCRIBED', or the error the
 * server gave ('PrivateOnly: …', 'Unauthorized: …'). The channel is left open for the caller,
 * and passed to `onJoined` so it can send.
 */
export function join(
  client: SupabaseClient,
  topic: string,
  { isPrivate }: { isPrivate: boolean },
  onBroadcast?: (payload: unknown) => void,
  onJoined?: (channel: RealtimeChannel) => void,
): Promise<string> {
  const channel = client.channel(topic, { config: { private: isPrivate } });
  onJoined?.(channel);
  if (onBroadcast) channel.on('broadcast', { event: '*' }, ({ payload }) => onBroadcast(payload));
  return new Promise((resolve) => {
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolve(status);
      else if (status !== 'CLOSED') resolve(error?.message ?? status);
    });
  });
}

/**
 * Makes the local stack refuse public channels, as production must (#457). The CLI's
 * config.toml has no setting for it, and Realtime re-seeds its local tenant on every start, so
 * global setup sets the tenant flag directly and waits out Realtime's tenant cache.
 */
export async function enforcePrivateOnly(): Promise<void> {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      // Again on every try: Realtime may still be restarting from `db reset` and re-seed it.
      await sql`update _realtime.tenants set private_only = true where not private_only`;
      const client = realtimeClient();
      const status = await join(client, 'private-only-probe', { isPrivate: false });
      await client.removeAllChannels();
      if (status.startsWith('PrivateOnly')) return;
      if (Date.now() > deadline) {
        throw new Error(`Realtime still accepts public channels after 120 s (join: ${status}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } finally {
    await sql.end();
  }
}
