import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// T1 (#66): the waiting-room TV shows each queue's now serving and next up, live. Three
// contexts: a guest joins, staff call from their tablet (the console's call button is C3, so
// through the same RPC), and the paired TV reacts.

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

async function recall(visit: { id: string; version: number }) {
  const { error } = await (
    await asStaff()
  ).rpc('transition_visit', {
    p_visit_id: visit.id,
    p_action: 'recall',
    p_expected_version: visit.version,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

async function pairTv(display: Page) {
  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
}

test('AC1: a call on the tablet highlights the ticket on the TV within 3 s @core', async ({
  devices,
}) => {
  const { display } = devices;
  const queue = await freshQueue();
  const { display_ticket: ticket } = await join(queue.id, 'Sam Rivera');
  await pairTv(display);

  const board = display.getByRole('region', { name: queue.name });
  await expect(board.getByTestId('next-up')).toContainText(ticket);
  await expect(board.getByTestId('now-serving')).not.toContainText(ticket);
  // Live means the TV's private loc: channel is joined, so the 30 s poll can't be what we see.
  await expect(display.getByTestId('reconnecting')).toHaveCount(0);

  await callNext(queue.id);
  const called = board.getByTestId('now-serving').getByText(ticket);
  await expect(called).toBeVisible({ timeout: 3_000 });
  await expect(called.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-highlight', 'true', {
    timeout: 3_000,
  });
  await expect(board.getByTestId('now-serving')).toContainText('Chair 1');
  await expect(board.getByTestId('next-up')).not.toContainText(ticket);
  await expectNoSeriousA11yViolations(display);
});

test('#529: a recall highlights the ticket again', async ({ devices }) => {
  const { display } = devices;
  const queue = await freshQueue();
  const { display_ticket: ticket } = await join(queue.id, 'Rita Recall');
  const visit = await callNext(queue.id);
  // Called before the TV loaded, so the first call is on screen and not highlighted.
  await pairTv(display);
  const item = display
    .getByRole('region', { name: queue.name })
    .getByTestId('now-serving')
    .getByText(ticket)
    .locator('xpath=ancestor::li[1]');
  await expect(item).toHaveAttribute('data-highlight', 'false');
  await expect(display.getByTestId('reconnecting')).toHaveCount(0);

  await recall(visit);
  await expect(item).toHaveAttribute('data-highlight', 'true', { timeout: 3_000 });
});

test('#529: a socket that stops answering shows the reconnect banner within about 15 s', async ({
  devices,
}) => {
  const { display } = devices;
  // Forward the realtime socket both ways until frozen, then drop everything: the connection
  // stays open but silent, like a dead Wi-Fi link. No close event reaches the page.
  let frozen = false;
  await display.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (!frozen) server.send(message);
    });
    server.onMessage((message) => {
      if (!frozen) ws.send(message);
    });
  });
  await pairTv(display);
  await expect(display.getByTestId('reconnecting')).toHaveCount(0);

  frozen = true;
  await expect(display.getByTestId('reconnecting')).toBeVisible({ timeout: 17_000 });
  frozen = false;
  await expect(display.getByTestId('reconnecting')).toHaveCount(0, { timeout: 30_000 });
});

test('AC2: with display names off, no guest names render', async ({ devices }) => {
  const { display } = devices;
  const queue = await freshQueue();
  const { display_ticket: waiting } = await join(queue.id, 'Zelda Quartz');
  const { display_ticket: next } = await join(queue.id, 'Yusuf Marlowe');
  await callNext(queue.id);
  await pairTv(display);

  const board = display.getByRole('region', { name: queue.name });
  await expect(board.getByTestId('now-serving')).toContainText(waiting);
  await expect(board.getByTestId('next-up')).toContainText(next);
  for (const name of ['Zelda', 'Quartz', 'Yusuf', 'Marlowe']) {
    await expect(display.locator('body')).not.toContainText(name);
  }
});
