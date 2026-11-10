import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { testUsers } from './support/users.ts';

// O2 (#73): the admin home shows today's numbers and keeps them live.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);
const anon = createClient(env.url, env.anonKey, noSession).schema('api');

test.use({ staffUser: 'owner' });

/** A queue of its own in the demo location, so parallel specs never serve each other's guests. */
async function freshQueue() {
  const { data, error } = await service
    .schema('app')
    .from('queues')
    .insert({
      org_id: demo.orgId,
      location_id: demo.locationId,
      name: `Dashboard ${randomUUID().slice(0, 8)}`,
      ticket_prefix: 'DSH',
      sort_order: 1000,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Joins a guest, then staff call, start and complete them: one more "served" today. */
async function serveOneGuest(queueId: string) {
  const { error: joinError } = await anon.rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: 'Sam',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  if (joinError) throw joinError;
  const staff = createClient(env.url, env.anonKey, noSession);
  const { error: signInError } = await staff.auth.signInWithPassword(testUsers.staff);
  if (signInError) throw signInError;
  const api = staff.schema('api');
  const called = await api.rpc('call_next', {
    p_queue_id: queueId,
    p_counter_id: demo.counters.chair1,
    p_idempotency_key: randomUUID(),
  });
  if (called.error) throw called.error;
  let visit = called.data as { id: string; version: number };
  for (const action of ['start', 'complete'] as const) {
    const next = await api.rpc('transition_visit', {
      p_visit_id: visit.id,
      p_action: action,
      p_expected_version: visit.version,
      p_idempotency_key: randomUUID(),
    });
    if (next.error) throw next.error;
    visit = next.data as { id: string; version: number };
  }
}

test('AC1: serving a guest increments "served" within 5 s', async ({ devices }) => {
  const { staff: admin } = devices;
  const queueId = await freshQueue();
  // Until a first visit exists the setup checklist replaces the tiles (DS-15), so make one.
  await serveOneGuest(queueId);
  await admin.goto('/admin');
  await expect(admin.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  // Live means the private loc: channel authorized with the owner's session (V9).
  await expect(admin.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  for (const label of [
    'Waiting now',
    'Average wait',
    'Joined today',
    'Served',
    'No-shows',
    'Cancelled',
  ]) {
    await expect(admin.getByText(label, { exact: true })).toBeVisible();
  }
  const served = admin.getByTestId('stat-served').locator('dd');
  const before = Number(await served.textContent());
  const joined = admin.getByTestId('stat-joined').locator('dd');
  const joinedBefore = Number(await joined.textContent());

  await serveOneGuest(queueId);
  // The 30 s poll can't make this; only the realtime signal can.
  // Other specs share the demo location, so count "at least one more", not exactly one.
  await expect
    .poll(async () => Number(await served.textContent()), { timeout: 5_000 })
    .toBeGreaterThan(before);
  // #495: the guest who came in counts as joined today too.
  expect(Number(await joined.textContent())).toBeGreaterThan(joinedBefore);
  await expectNoSeriousA11yViolations(admin);
});

test('the home shows who is waiting and hands off to the live queue', async ({ devices }) => {
  const { staff: admin } = devices;
  const queueId = await freshQueue();
  const { error } = await anon.rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: 'Riley',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  await admin.goto('/admin');
  const card = admin.getByTestId('right-now');
  await expect(card.getByRole('heading', { name: 'Right now' })).toBeVisible();
  await expect(admin.getByTestId('right-now-count')).toHaveText(/\d+ (person|people) waiting/);
  await expectNoSeriousA11yViolations(admin);
  await card.getByRole('link', { name: 'Open live queue' }).click();
  await expect(admin).toHaveURL(/\/staff$/);
});
