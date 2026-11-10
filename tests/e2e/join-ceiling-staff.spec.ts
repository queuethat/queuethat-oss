import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// #492: staff see when a queue hits its hourly online-join ceiling (#482), live, without a reload;
// only managers and up can change the ceiling. Guests see it on the join page before they try.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);
const anon = createClient(env.url, env.anonKey, noSession).schema('api');

/** A guest's online join from a phone of its own, as /q does. */
async function onlineJoin(queueId: string, name: string) {
  const { error } = await anon.rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: randomUUID().replaceAll('-', ''),
  });
  expect(error).toBeNull();
}

test('a queue at its hourly online ceiling shows staff a banner within 3 s', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ online_joins_per_hour: 2 })
    .eq('id', queue.id);
  expect(error).toBeNull();

  await staff.goto(`/staff?queue=${queue.id}`);
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  const banner = staff.getByText(/^Online joins paused: this queue reached its hourly limit/);
  for (let i = 0; i < 2; i++) {
    await expect(banner).toHaveCount(0);
    await onlineJoin(queue.id, `Guest ${i + 1}`);
  }
  await expect(banner).toBeVisible({ timeout: 3_000 });
  await expect(staff.getByRole('tab', { selected: true })).toContainText('Online full');
});

test('at the ceiling the join page sends guests to the front desk and Join is disabled', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ online_joins_per_hour: 1 })
    .eq('id', queue.id);
  expect(error).toBeNull();
  const notice = guest
    .getByRole('status')
    .filter({ hasText: 'Please check in at the front desk.' });
  const join = guest.getByRole('button', { name: 'Join the queue' });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await expect(join).toBeEnabled();
  await expect(notice).toHaveCount(0);

  await onlineJoin(queue.id, 'Guest 1');
  await guest.reload();
  await guest.getByLabel('Queue').selectOption(queue.id);
  await expect(notice).toBeVisible();
  await expect(join).toBeDisabled();
});

test("staff can't change a queue's online ceiling", async () => {
  const queue = await freshQueue();
  const staffClient = createClient(env.url, env.anonKey, noSession);
  const { error: signInError } = await staffClient.auth.signInWithPassword(testUsers.staff);
  expect(signInError).toBeNull();
  const { data, error } = await staffClient
    .schema('app')
    .from('queues')
    .update({ online_joins_per_hour: 999 })
    .eq('id', queue.id)
    .select('id');
  expect(error ?? data).toEqual([]);
  const { data: row } = await service
    .schema('app')
    .from('queues')
    .select('online_joins_per_hour')
    .eq('id', queue.id)
    .single();
  expect(row).toEqual({ online_joins_per_hour: 120 });
});
