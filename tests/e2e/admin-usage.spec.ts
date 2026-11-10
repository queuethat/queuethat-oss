import { createClient } from '@supabase/supabase-js';
import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';
import { createMember } from './support/members.ts';

// 3-PV5 (#344): /admin/usage shows today's sends against the cap and the editable limits.

const { url, serviceRoleKey } = supabaseEnv();
const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema(
  'app',
);

test.use({ staffUser: null });

test('AC1, AC3: 160 of 200 SMS today shows the 80% banner and the page is axe clean', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const [orgs] = (await readAs(email, ['organizations?select=id'])) as [{ id: string }[]];
  const { error } = await service.from('usage_counters').insert({
    org_id: orgs[0]!.id,
    channel: 'sms',
    day: new Date().toISOString().slice(0, 10),
    sent: 160,
  });
  expect(error).toBeNull();
  await signInTo(staff, email, '/admin/usage');
  await expect(staff.getByRole('heading', { name: 'Usage and limits' })).toBeVisible();
  await expect(staff.getByTestId('banner-sms')).toHaveText("SMS is at 80% of today's cap.");
  await expect(staff.getByTestId('banner-whatsapp')).toHaveCount(0);
  await expect(staff.getByText('SMS: 160 of 200 messages today')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});

test('an owner saves caps and allowed countries', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/usage');
  await staff.getByLabel('Daily SMS cap').fill('50');
  await staff.getByLabel('United States').check();
  await staff.getByRole('button', { name: 'Save limits' }).click();
  await expect(staff.getByRole('status').filter({ hasText: 'Limits saved.' })).toBeVisible();
  const [rows] = (await readAs(email, [
    'channel_limits?select=channel,daily_cap,country_allowlist&order=channel',
  ])) as [{ channel: string; daily_cap: number; country_allowlist: string[] }[]];
  expect(rows).toEqual([
    { channel: 'sms', daily_cap: 50, country_allowlist: ['US'] },
    { channel: 'whatsapp', daily_cap: 200, country_allowlist: ['US'] },
  ]);
});

test('AC2: a manager sees usage but the limits are read-only', async ({ devices }) => {
  const { staff } = devices;
  const manager = await createMember('Usage Manager', { role: 'manager' });
  await staff.goto('/auth/sign-in?next=%2Fadmin%2Fusage');
  await staff.getByLabel('Email').fill(manager.email);
  await staff.getByLabel('Password').fill(DEMO_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await staff.waitForURL((u) => u.pathname === '/admin/usage');
  await expect(staff.getByText('Only admins and owners can change limits.')).toBeVisible();
  await expect(staff.getByLabel('Daily SMS cap')).toBeDisabled();
  await expect(staff.getByRole('button', { name: 'Save limits' })).toHaveCount(0);
});
