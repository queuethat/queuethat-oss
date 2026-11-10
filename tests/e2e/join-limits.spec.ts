import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures.ts';
import { demo } from '../fixtures/demo.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// #441, #474: online joins are capped per phone (hashed client IP plus the browser's device
// key) and per network (the IP alone, 60 per 10 minutes) per queue. Every request in this run
// comes from one address, as guests on a venue's Wi-Fi do.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const anon = createClient(env.url, env.anonKey, noSession).schema('api');
const PER_NETWORK = 60;

function joinFromPhone(queueId: string, name: string, deviceKey: string) {
  return anon.rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: deviceKey,
  });
}

test('sixty phones on one network get in, the next is sent to staff, and staff can still add them', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();
  // Past the old per-IP cap of 10: each phone has its own budget.
  for (let i = 0; i < PER_NETWORK; i++) {
    const { error } = await joinFromPhone(
      queue.id,
      `Guest ${i + 1}`,
      randomUUID().replaceAll('-', ''),
    );
    expect(error).toBeNull();
  }

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Sixty-one');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(
    guest.getByText('Too many joins from this network right now. Please ask staff to add you.'),
  ).toBeVisible();
  await expect(guest).toHaveURL(new RegExp(`/q/${demo.locationSlug}$`));

  const staffClient = createClient(env.url, env.anonKey, noSession);
  const { error: signInError } = await staffClient.auth.signInWithPassword(testUsers.staff);
  expect(signInError).toBeNull();
  const { data, error } = await staffClient.schema('api').rpc('staff_add_visit', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Sixty-one',
    p_phone_e164: null,
    p_party_size: 1,
    p_idempotency_key: randomUUID(),
  });
  expect(error).toBeNull();
  expect(data).toMatchObject({ status: 'waiting', position: PER_NETWORK + 1 });
});

test('a phone that joins again lands on its existing visit, not a second ticket', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const tickets: string[] = [];
  guest.on('response', async (response) => {
    if (!response.url().endsWith('/rpc/join_queue') || !response.ok()) return;
    tickets.push(((await response.json()) as { display_ticket: string }).display_ticket);
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Dana');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const statusUrl = guest.url();

  // Scanning the poster again goes straight back to the status page. The page redirects before
  // it finishes loading, so a goto or a wait for the /q URL can race past it. Instead wait until
  // the old window is gone, then assert where the page landed.
  await guest.evaluate((path) => {
    (window as { beforeRescan?: boolean }).beforeRescan = true;
    location.assign(path);
  }, `/q/${demo.locationSlug}`);
  // The flag lives on the old window, so it is gone once the poster has loaded and redirected.
  // (A waitForEvent('load') can miss that load on WebKit and time out.) An evaluate that lands
  // mid-navigation throws, which also means the old window is going away.
  await expect
    .poll(() =>
      guest
        .evaluate(() => (window as { beforeRescan?: boolean }).beforeRescan ?? null)
        .catch(() => null),
    )
    .toBeNull();
  await expect(guest).toHaveURL(statusUrl);
  await guest.waitForLoadState('networkidle');

  // Even with the saved link gone, the device key finds the same visit and its link.
  await guest.evaluate(() => {
    for (const name of Object.keys(localStorage)) {
      if (name.startsWith('qm:visit:')) localStorage.removeItem(name);
    }
  });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Dana');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(statusUrl);
  expect(new Set(tickets).size).toBe(1);
});
