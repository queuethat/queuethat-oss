import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, restAs } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';

// 4-WL1 (#376): an org can hide the product name; the AGPL source link always stays.
test.use({ staffUser: null });

const SOURCE = 'https://github.com/queuethat/queuethat-oss';
const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test('AC1: the join page names the product until the owner hides it, and keeps the source link', async ({
  devices,
}) => {
  const { guest } = devices;
  const { email, slug } = await ownerOfNewBusiness();

  await guest.goto(`/q/${slug}`);
  await expect(guest.getByText('Powered by QueueThat')).toBeVisible();
  await expect(guest.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', SOURCE);

  const [org] = (await (await restAs(email, `organizations?select=id`)).json()) as { id: string }[];
  const patch = await restAs(email, `organizations?id=eq.${org!.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ hide_product_branding: true }),
  });
  expect(patch.ok).toBe(true);

  await guest.goto(`/q/${slug}`);
  await expect(guest.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', SOURCE);
  await expect(guest.getByText('Powered by')).toHaveCount(0);
  expect(await guest.locator('body').innerText()).not.toContain('QueueThat');
  expect(await guest.title()).not.toContain('QueueThat');
  await expectNoSeriousA11yViolations(guest);
});

test('AC1: the paired TV drops the product name when the org hides it', async ({ devices }) => {
  const { display } = devices;
  const set = (hide: boolean) =>
    service
      .schema('app')
      .from('organizations')
      .update({ hide_product_branding: hide })
      .eq('id', demo.orgId);
  expect((await set(true)).error).toBeNull();
  try {
    await servePairDevice(display);
    await display.goto('/display');
    await pair(display, await newCode('display'));
    await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
    const line = display.getByTestId('product-line');
    await expect(line.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', SOURCE);
    await expect(line).not.toContainText('QueueThat');
  } finally {
    await set(false);
  }
});
