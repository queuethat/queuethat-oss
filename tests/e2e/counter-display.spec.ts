import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// 2B-D2 (#259): a counter display shows its own counter's ticket, live, and no other counter's.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);

async function signedIn(user: { email: string; password: string }) {
  const client = createClient(env.url, env.anonKey, noSession);
  const { error } = await client.auth.signInWithPassword(user);
  if (error) throw error;
  return client;
}

/** A counter of its own, so parallel specs calling "Chair 1" never change this screen. */
async function freshCounter(label: string) {
  const { data, error } = await service
    .schema('app')
    .from('counters')
    .insert({ org_id: demo.orgId, location_id: demo.locationId, label })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function join(queueId: string, name: string) {
  const anon = createClient(env.url, env.anonKey, noSession).schema('api');
  const { data, error } = await anon.rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return data as { display_ticket: string };
}

async function callTo(queueId: string, counterId: string) {
  const staff = await signedIn(testUsers.staff);
  const { error } = await staff.schema('api').rpc('call_next', {
    p_queue_id: queueId,
    p_counter_id: counterId,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

/** Pairs `page` as a display for `counterId` and opens `/display/counter`. */
async function pairCounterScreen(page: Page, counterId: string | null) {
  const name = `E2E counter ${randomUUID()}`;
  await servePairDevice(page);
  await page.goto('/display/counter');
  await pair(page, await newCode('display', name));
  if (counterId) {
    const owner = await signedIn(testUsers.owner);
    // The device row appears once pair-device has registered it.
    let id: string | undefined;
    await expect
      .poll(async () => {
        const { data } = await owner.schema('app').from('devices').select('id').eq('name', name);
        id = data?.[0]?.id;
        return id;
      })
      .toBeTruthy();
    const { error } = await owner
      .schema('api')
      .rpc('set_device_counter', { p_device_id: id!, p_counter_id: counterId });
    if (error) throw error;
    // The device row exists before this tab has stored its credentials; reloading earlier lands
    // on the pairing form again (iPhone and iPad, repeat runs).
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);
    await page.reload();
  }
}

test('AC1: a call at the counter shows its ticket within 3 s, and not on another counter', async ({
  devices,
}) => {
  const { display } = devices;
  const mine = await freshCounter(`Desk ${randomUUID().slice(0, 4)}`);
  const other = await freshCounter(`Desk ${randomUUID().slice(0, 4)}`);
  const queue = await freshQueue();
  const { display_ticket: ticket } = await join(queue.id, 'Sam Rivera');

  await pairCounterScreen(display, mine);
  await expect(display.getByTestId('counter-idle')).toBeVisible();
  await expect(display.getByTestId('reconnecting')).toHaveCount(0);

  const second = await display
    .context()
    .browser()!
    .newContext({ viewport: { width: 800, height: 480 } });
  const small = await second.newPage();
  await pairCounterScreen(small, other);
  await expect(small.getByTestId('counter-idle')).toBeVisible();

  await callTo(queue.id, mine);
  await expect(display.getByTestId('counter-ticket')).toHaveText(ticket, { timeout: 3_000 });
  await expect(
    display.getByTestId('counter-ticket').locator('xpath=ancestor::section'),
  ).toHaveAttribute('data-highlight', 'true');
  await expect(small.getByTestId('counter-idle')).toBeVisible();
  await expect(small.getByTestId('counter-ticket')).toHaveCount(0);
  await expectNoSeriousA11yViolations(display);
  await second.close();
});

test('a display with no counter says so', async ({ devices }) => {
  const { display } = devices;
  await pairCounterScreen(display, null);
  await expect(display.getByRole('alert')).toContainText("isn't assigned to a counter");
});
