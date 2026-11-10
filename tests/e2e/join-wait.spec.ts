import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// G-14 (#130): the join page shows the wait for the queue a guest is about to join, live.

/** Calls an api.* function over REST, as anon or with `bearer`. */
async function rpc(fn: string, args: object, bearer?: string) {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${bearer ?? anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
      'accept-profile': 'api',
    },
    body: JSON.stringify(args),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}

async function staffToken(): Promise<string> {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(testUsers.staff),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

const joinAs = (queueId: string, name: string) =>
  rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });

test('AC1: the waiting count on an open join page drops when staff call a guest', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await joinAs(queue.id, 'Ana');
  await joinAs(queue.id, 'Ben');

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  const wait = guest.getByTestId('join-wait');
  await expect(wait).toContainText('2 waiting');

  await rpc(
    'call_next',
    { p_queue_id: queue.id, p_counter_id: demo.counters.chair1, p_idempotency_key: randomUUID() },
    await staffToken(),
  );
  await expect(wait).toContainText('1 waiting', { timeout: 5_000 });
});
