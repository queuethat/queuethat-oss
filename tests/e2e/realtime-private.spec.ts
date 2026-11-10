import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { eventually, expect, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { join, realtimeClient } from './support/realtime.ts';
import { testUsers } from './support/users.ts';

// #457: Realtime takes private channels only, and the realtime.messages policies decide who
// hears what. Global setup switches the local stack to private-only, as production must be.

const staffTopic = `loc:${demo.locationId}`;
const clients: ReturnType<typeof realtimeClient>[] = [];
const client = (token: string | null = null) => {
  const c = realtimeClient(token);
  clients.push(c);
  return c;
};
test.afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.removeAllChannels()));
});

test('public channels are refused, whatever the topic', async () => {
  for (const topic of [staffTopic, `qpulse:${randomUUID()}`]) {
    expect(await join(client(), topic, { isPrivate: false })).toMatch(/^PrivateOnly/);
  }
});

test('anon cannot subscribe to a staff topic; staff of the location can', async () => {
  expect(await join(client(), staffTopic, { isPrivate: true })).toMatch(/^Unauthorized/);
  expect(await join(client(await staffToken()), staffTopic, { isPrivate: true })).toBe(
    'SUBSCRIBED',
  );
});

test('anon hears a queue pulse through the policy but cannot forge one', async () => {
  const { url, anonKey, serviceRoleKey } = supabaseEnv();
  const queue = await freshQueue();
  const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { data } = await service
    .schema('app')
    .from('queues')
    .select('pulse_id')
    .eq('id', queue.id)
    .single();
  const topic = `qpulse:${data!.pulse_id}`;

  const heard: unknown[] = [];
  expect(await join(client(), topic, { isPrivate: true }, (p) => heard.push(p))).toBe('SUBSCRIBED');
  let forger: RealtimeChannel | undefined;
  expect(await join(client(), topic, { isPrivate: true }, undefined, (c) => (forger = c))).toBe(
    'SUBSCRIBED',
  );
  await forger!.send({ type: 'broadcast', event: 'pulse', payload: { version: 999 } });

  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await anon.schema('api').rpc('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Pulse',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  expect(error).toBeNull();

  // The join's real pulse arrives; the forged one never does.
  await eventually(() => heard.length).toBeGreaterThan(0);
  expect(heard).not.toContainEqual(expect.objectContaining({ version: 999 }));
  // Realtime adds the realtime.messages row id to database broadcasts; the rest is ours (I-5).
  const keys = Object.keys(heard[0] as object).filter((k) => k !== 'id');
  expect(keys.sort()).toEqual(['now_serving', 'version']);
});

async function staffToken() {
  const auth = createClient(supabaseEnv().url, supabaseEnv().anonKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await auth.auth.signInWithPassword(testUsers.staff);
  if (error) throw error;
  return data.session.access_token;
}
