import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

import { supabaseEnv } from './support/env.ts';

// A-16 (#172): a member creates, copies and revokes a calendar feed link.
test.use({ staffUser: 'owner' });

// The feed Edge Function is not served in the e2e stack; it answers 404 exactly when this RPC
// raises not_found (supabase/functions/ics-feed/handler.test.ts), so the RPC is what is asserted.
async function feedStatus(token: string): Promise<200 | 404> {
  const env = supabaseEnv();
  const service = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
  const { error } = await service.schema('api').rpc('calendar_feed_events', { p_token: token });
  return error?.message === 'not_found' ? 404 : 200;
}

test('the link is shown once, then only a masked hint, and revoking kills the feed', async ({
  devices,
}) => {
  const { staff } = devices;
  await staff.goto('/admin/account/calendar');
  await expect(staff.getByRole('heading', { name: 'Calendar feed' })).toBeVisible();
  await expect(staff.getByText(/Anyone with the link can read/)).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('button', { name: 'Create a calendar link' }).click();
  const https = staff.getByLabel('Web link (https)');
  await expect(https).toBeVisible();
  const url = await https.inputValue();
  const token = url.split('/').pop()!.replace('.ics', '');
  expect(url).toMatch(/\/ics-feed\/[\w-]{43}\.ics$/);
  expect(await staff.getByLabel('Subscribe link (webcal)').inputValue()).toMatch(/^webcal:/);
  expect(await feedStatus(token)).toBe(200);

  await staff.reload();
  await expect(staff.getByLabel('Web link (https)')).toHaveCount(0);
  await expect(staff.getByText(url.split('/').pop()!.slice(0, 20))).toHaveCount(0);
  await expect(staff.getByTestId('feed').first()).toContainText('••••');

  await staff.getByRole('button', { name: 'Revoke' }).first().click();
  await expect(staff.getByRole('dialog')).toBeVisible();
  expect(await feedStatus(token)).toBe(200); // nothing happens until confirmed
  await staff.getByRole('button', { name: 'Revoke link' }).click();
  await expect(staff.getByRole('dialog')).toBeHidden();
  expect(await feedStatus(token)).toBe(404);
});
