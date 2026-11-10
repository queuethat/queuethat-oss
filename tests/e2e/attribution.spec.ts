import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { withPublicJoin } from './support/public-join.ts';
import { freshQueue } from './support/queues.ts';

// 2B-J8 (#246): a join that came through a Google Business Profile link is attributed to it.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function joinWith(
  guest: import('@playwright/test').Page,
  query: string,
  name: string,
): Promise<string | null> {
  await withPublicJoin(guest, 'dev');
  const queue = await freshQueue();
  await guest.goto(`/q/${demo.locationSlug}${query}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill(name);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const { data, error } = await service
    .schema('app')
    .from('visits')
    .select('attribution')
    .eq('queue_id', queue.id)
    .single();
  if (error) throw error;
  return data.attribution;
}

test('AC1: ?src=gbp is stored as gbp', async ({ devices }) => {
  expect(await joinWith(devices.guest, '?src=gbp', 'Gail')).toBe('gbp');
});

test('AC2: a hostile src is dropped and nothing of it is stored', async ({ devices }) => {
  expect(await joinWith(devices.guest, '?src=%3Cscript%3E', 'Hal')).toBeNull();
});

test('AC3: the admin page shows the link with src=gbp', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/google');
  await expect(staff.getByTestId('gbp-link')).toHaveText(
    new RegExp(`/q/${demo.locationSlug}\\?src=gbp$`),
  );
});
