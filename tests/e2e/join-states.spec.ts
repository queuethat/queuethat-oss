import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// DS-19 (#1023): the join page leads with the wait, and Paused, Closed and Full each have their own
// labelled look. The reasons come from the database; these tests only change the queue's state.
const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rpc(fn: string, args: object, bearer: string) {
  const response = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'content-profile': 'api',
      'accept-profile': 'api',
    },
    body: JSON.stringify(args),
  });
  expect(response.ok, `${fn}: ${await response.clone().text()}`).toBe(true);
}

async function staffToken(): Promise<string> {
  const response = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(testUsers.staff),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

test('an open queue shows the Open pill and the wait above the form', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  const wait = guest.getByTestId('join-wait');
  await expect(wait).toBeVisible();
  await expect(guest.getByText('Open', { exact: true })).toBeVisible();
  const waitBox = await wait.boundingBox();
  const nameBox = await guest.getByLabel('First name').boundingBox();
  expect(waitBox!.y).toBeLessThan(nameBox!.y);
  await expectNoSeriousA11yViolations(guest);
});

for (const [state, label, sentence] of [
  ['paused', 'Paused', 'This queue is paused. Please check back in a few minutes.'],
  ['closed', 'Closed', 'This queue is closed right now.'],
] as const) {
  test(`a ${state} queue shows a ${label} banner and Join stays off`, async ({ devices }) => {
    const { guest } = devices;
    const queue = await freshQueue();
    await rpc('set_queue_state', { p_queue_id: queue.id, p_state: state }, await staffToken());
    await guest.goto(`/q/${demo.locationSlug}`);
    await guest.getByLabel('Queue').selectOption(queue.id);
    const banner = guest.getByTestId('join-state');
    await expect(banner).toContainText(label);
    await expect(banner).toContainText(sentence);
    await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();
    await expectNoSeriousA11yViolations(guest);
  });
}

test('a full queue shows a Full banner', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ capacity: 1 })
    .eq('id', queue.id);
  if (error) throw error;
  await rpc(
    'join_queue',
    {
      p_queue_id: queue.id,
      p_service_id: null,
      p_name: 'First',
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
    },
    env.anonKey,
  );
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  const banner = guest.getByTestId('join-state');
  await expect(banner).toContainText('Full');
  await expect(banner).toContainText('This queue is full right now. Please check back soon.');
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();
});
