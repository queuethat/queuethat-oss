import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

const databaseUrl =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

// 2B-W3 (#291): owners see how often the quoted range held.
test.use({ staffUser: 'owner' });

test('AC1, AC2: the headline matches the RPC and axe is clean', async ({ devices }) => {
  const { staff } = devices;
  const env = supabaseEnv();
  const owner = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await owner.auth.signInWithPassword(testUsers.owner);
  if (signInError) throw signInError;

  // One visit called 15 minutes after it joined, quoted 10-20 minutes.
  const queue = await freshQueue();
  const added = await owner.schema('api').rpc('staff_add_visit', {
    p_queue_id: queue.id,
    p_service_id: null as unknown as string,
    p_name: 'Eta Guest',
    p_phone_e164: null as unknown as string,
    p_party_size: 1,
    p_idempotency_key: randomUUID(),
  });
  if (added.error) throw added.error;
  const visit = added.data as { id: string };
  const called = await owner.schema('api').rpc('call_next', {
    p_queue_id: queue.id,
    p_counter_id: null as unknown as string,
    p_idempotency_key: randomUUID(),
  });
  if (called.error) throw called.error;
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select private.set_actor('system', null)`;
      await tx`update app.visits
               set eta_quoted_low = 10, eta_quoted_high = 20, joined_at = now() - interval '15 minutes'
               where id = ${visit.id}`;
    });
  } finally {
    await sql.end();
  }

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const rows = await owner.schema('api').rpc('eta_accuracy', {
    p_location_id: demo.locationId,
    p_from_day: day(-30),
    p_to_day: day(1),
    p_group: 'day',
  });
  if (rows.error) throw rows.error;
  const data = rows.data as { visits: number | null; within_range_pct: number | null }[];
  const quoted = data.reduce((n, r) => n + (r.visits ?? 0), 0);
  const within = data.reduce((n, r) => n + ((r.within_range_pct ?? 0) * (r.visits ?? 0)) / 100, 0);
  const expected = Math.round((within / quoted) * 100);

  await staff.goto('/admin/eta-accuracy');
  await staff.getByLabel('To').fill(day(1));
  await expect(staff.getByRole('heading', { name: 'ETA accuracy' })).toBeVisible();
  await expect(staff.getByTestId('eta-headline')).toContainText(`${expected}% of guests`);
  await expect(staff.getByRole('table', { name: 'By service' })).toBeVisible();
  await expect(staff.getByRole('link', { name: /queue settings/ })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});
