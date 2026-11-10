import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// 4-SIG2 (#390): the TV rotates slides under the board, and a call always takes the panel over.
const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);
const anon = createClient(env.url, env.anonKey, noSession).schema('api');

test('AC1: a call interrupts the slide within 3 s and the now-serving area stays visible', async ({
  devices,
}) => {
  const { display } = devices;
  const queue = await freshQueue();
  const marker = `Slide ${randomUUID().slice(0, 8)}`;
  const inserted = await service
    .schema('app')
    .from('signage_slides')
    .insert({
      org_id: demo.orgId,
      location_id: demo.locationId,
      kind: 'text',
      body: marker,
      duration_s: 30,
      sort: -1000,
    })
    .select('id')
    .single();
  expect(inserted.error).toBeNull();
  try {
    const { data: joined, error } = await anon.rpc('join_queue', {
      p_queue_id: queue.id,
      p_service_id: null,
      p_name: 'Sam Rivera',
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
    });
    if (error) throw error;
    const ticket = (joined as { display_ticket: string }).display_ticket;

    await servePairDevice(display);
    await display.goto('/display');
    await pair(display, await newCode('display'));
    await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
    await expect(display.getByTestId('slide-panel')).toContainText(marker, { timeout: 15_000 });
    await expect(display.getByTestId('reconnecting')).toHaveCount(0);
    await expectNoSeriousA11yViolations(display);

    const staff = createClient(env.url, env.anonKey, noSession);
    expect((await staff.auth.signInWithPassword(testUsers.staff)).error).toBeNull();
    const called = await staff.schema('api').rpc('call_next', {
      p_queue_id: queue.id,
      p_counter_id: demo.counters.chair1,
      p_idempotency_key: randomUUID(),
    });
    expect(called.error).toBeNull();

    const takeover = display.getByTestId('call-takeover');
    await expect(takeover).toContainText(ticket, { timeout: 3_000 });
    await expect(display.getByTestId('slide-panel')).toHaveCount(0);
    const board = display.getByRole('region', { name: queue.name });
    await expect(board.getByTestId('now-serving')).toContainText(ticket);
    await expect(board.getByTestId('now-serving')).toBeInViewport();
  } finally {
    await service.schema('app').from('signage_slides').delete().eq('id', inserted.data!.id);
  }
});
