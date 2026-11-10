import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// PLT9 (#415). Announcements are written here with the service role, standing in for an
// operator's api.platform_upsert_announcement call (which needs an MFA session).
type Row = {
  severity: 'info' | 'warning' | 'maintenance';
  message: string;
  starts_at: string;
  ends_at: string;
};

async function rest(method: 'POST' | 'DELETE', query: string, body?: Row[]) {
  const { url, serviceRoleKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/platform_announcements${query}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      'content-profile': 'app',
      'accept-profile': 'app',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`${method} announcements: ${response.status} ${await response.text()}`);
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
// Unique per run and per project, so parallel projects only look for their own rows.
const run = randomUUID().slice(0, 8);
const text = {
  maintenance: `Maintenance tonight ${run}`,
  info: `New reports page ${run}`,
  ended: `Yesterday's incident ${run}`,
};

test.beforeAll(async () => {
  await rest('POST', '', [
    { severity: 'maintenance', message: text.maintenance, starts_at: hours(-1), ends_at: hours(1) },
    { severity: 'info', message: text.info, starts_at: hours(-1), ends_at: hours(1) },
    { severity: 'warning', message: text.ended, starts_at: hours(-3), ends_at: hours(-2) },
  ]);
});
test.afterAll(async () => {
  await rest('DELETE', `?message=like.*${run}`);
});

test('staff pages show active announcements; only info can be dismissed', async ({
  devices,
}, testInfo) => {
  const { staff } = devices;
  await staff.goto('/staff');
  const maintenance = staff.getByRole('status').filter({ hasText: text.maintenance });
  const info = staff.getByRole('status').filter({ hasText: text.info });

  // AC1: shown, and not dismissible.
  await expect(maintenance).toBeVisible();
  await expect(maintenance.getByRole('button')).toHaveCount(0);
  // AC2: an ended announcement is not shown.
  await expect(staff.getByText(text.ended)).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
  await testInfo.attach('staff-layout', {
    body: await staff.screenshot(),
    contentType: 'image/png',
  });

  await info.getByRole('button', { name: 'Dismiss' }).click();
  await expect(info).toHaveCount(0);
  await staff.reload();
  await expect(maintenance).toBeVisible();
  await expect(info).toHaveCount(0);

  // AC1: every staff page, admin included.
  await staff.goto('/admin');
  await expect(maintenance).toBeVisible();
});

test('guest pages never show announcements', async ({ devices }) => {
  const { guest } = devices;
  // AC3: the join page and the status page.
  for (const path of [`/q/${demo.locationSlug}`, `/v/${'x'.repeat(43)}`]) {
    await guest.goto(path);
    await expect(guest.locator('[data-layout="guest"]')).toBeVisible();
    await expect(guest.getByText(text.maintenance)).toHaveCount(0);
    await expect(guest.getByTestId('announcements')).toHaveCount(0);
  }
});
