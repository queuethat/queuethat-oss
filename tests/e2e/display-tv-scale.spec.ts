import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// DS-21 (#1025): the TV board at TV scale. Ticket numbers are 96 px on a 1920 screen, a new call
// wears the called look with a ring and a "Called" label (so it reads without colour), and the
// high-contrast theme still passes axe.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const anon = createClient(env.url, env.anonKey, noSession).schema('api');

async function join(queueId: string, name: string) {
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

async function asStaff() {
  const staff = createClient(env.url, env.anonKey, noSession);
  const { error } = await staff.auth.signInWithPassword(testUsers.staff);
  if (error) throw error;
  return staff.schema('api');
}

async function callNext(queueId: string) {
  const { data, error } = await (
    await asStaff()
  ).rpc('call_next', {
    p_queue_id: queueId,
    p_counter_id: demo.counters.chair1,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return data as { id: string; version: number };
}

test('a called ticket is 96 px with a Called label and a ring; high contrast passes axe', async ({
  devices,
}) => {
  const { display } = devices;
  await display.setViewportSize({ width: 1920, height: 1080 });
  const queue = await freshQueue();
  const { display_ticket: ticket } = await join(queue.id, 'Sam Rivera');
  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  const board = display.getByRole('region', { name: queue.name });
  await expect(display.getByTestId('reconnecting')).toHaveCount(0);

  await callNext(queue.id);
  const serving = board.getByTestId('now-serving');
  const called = serving.getByText(ticket);
  await expect(called).toBeVisible({ timeout: 3_000 });
  await expect(called).toHaveCSS('font-size', '96px');
  const item = called.locator('xpath=ancestor::li[1]');
  await expect(item).toHaveAttribute('data-highlight', 'true');
  await expect(item.getByText('Called', { exact: true })).toBeVisible();
  await expect(item).toHaveCSS('box-shadow', /rgb/); // the ring
  await expectNoSeriousA11yViolations(display);

  await display.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'high-contrast'),
  );
  await expectNoSeriousA11yViolations(display);
});
