import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// #566: the join page used to join one realtime channel per queue. Past 100 (Realtime's cap per
// client) the status page's own channel was refused and the guest sat at "Offline". It now
// follows only the queue the form would join, so the queue count doesn't matter.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('app');
const QUEUES = 120;
let slug = '';
let orgId = '';
let locationId = '';
let pickedId = '';

test.beforeAll(async () => {
  slug = `e2e-many-${randomUUID().slice(0, 8)}`;
  // An organization and location of their own (no business hours, so open all day): 120 queues
  // at the demo location would crowd every other spec's console, and a second demo location
  // would change what demo staff see.
  const { data: org, error: orgError } = await service
    .from('organizations')
    .insert({ name: 'E2E many queues' })
    .select('id')
    .single();
  if (orgError) throw orgError;
  orgId = org.id as string;
  const { data: location, error } = await service
    .from('locations')
    .insert({ org_id: orgId, name: 'Many queues', slug, tz: 'UTC' })
    .select('id')
    .single();
  if (error) throw error;
  locationId = location.id as string;
  const { data: queues, error: queuesError } = await service
    .from('queues')
    .insert(
      Array.from({ length: QUEUES }, (_, i) => ({
        org_id: orgId,
        location_id: locationId,
        name: `Queue ${String(i + 1).padStart(3, '0')}`,
        ticket_prefix: String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
        sort_order: i,
      })),
    )
    .select('id, name');
  if (queuesError) throw queuesError;
  pickedId = queues.find((q) => q.name === 'Queue 077')!.id as string;
});

test.afterAll(async () => {
  await service
    .from('queues')
    .update({ archived_at: new Date().toISOString() })
    .eq('location_id', locationId);
});

test('with 120 queues the join page follows one, and the status page goes live', async ({
  devices,
}) => {
  const { guest } = devices;
  const joined = new Set<string>();
  guest.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/v1/')) return;
    ws.on('framesent', ({ payload }) => {
      const frame = typeof payload === 'string' ? payload : payload.toString();
      // Phoenix v2 frames: [join_ref, ref, topic, event, payload].
      const match = /^\["?[^,]*"?,"?[^,]*"?,"realtime:([^"]+)","phx_join"/.exec(frame);
      if (match) joined.add(match[1]!);
    });
  });

  await guest.goto(`/q/${slug}`);
  await expect(guest.getByRole('heading', { name: 'Join the queue' })).toBeVisible();
  await expect.poll(() => joined.size).toBe(1);

  // Picking another queue moves the one channel to it.
  await guest.getByLabel('Queue').selectOption(pickedId);
  await expect.poll(() => joined.size).toBe(2);

  await guest.getByLabel('First name').fill('Manny');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expect(guest.getByRole('status').filter({ hasText: 'Live' })).toHaveAttribute(
    'data-state',
    'live',
    { timeout: 15_000 },
  );
  expect(joined.size).toBeLessThanOrEqual(3);
});
