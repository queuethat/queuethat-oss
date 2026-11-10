import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// 2P-NTF9 (#181): managers message everyone in a queue from the staff console.
// The guests here have nowhere to be reached (no push, no stored contact), so the toast counts
// them as skipped; delivery into the dev inbox is covered by supabase/tests/notifications/broadcast.test.sql.

async function guestJoins(name: string, queueId: string) {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: queueId,
      p_service_id: null,
      p_name: name,
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  if (!response.ok) throw new Error(`join_queue: ${response.status} ${await response.text()}`);
}

test.describe('as staff', () => {
  test('AC2: the button is hidden', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/staff');
    await expect(staff.getByRole('tab', { name: 'Walk-ins' })).toBeVisible();
    await expect(staff.getByRole('button', { name: 'Message everyone' })).toHaveCount(0);
  });
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: review, send, and the toast says how many were reached and skipped', async ({
    devices,
  }) => {
    const { staff } = devices;
    const queue = await freshQueue();
    await guestJoins('One', queue.id);
    await guestJoins('Two', queue.id);
    await staff.goto(`/staff?queue=${queue.id}`);
    await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
    await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(2);

    await staff.getByRole('button', { name: 'Message everyone' }).click();
    const dialog = staff.getByRole('dialog');
    await dialog.getByRole('button', { name: /running about 15 minutes/ }).click();
    await expect(dialog.getByText('1 text segment')).toBeVisible();
    await expectNoSeriousA11yViolations(staff);
    await dialog.getByRole('button', { name: 'Review' }).click();
    await expect(dialog.getByRole('heading', { name: 'Send to up to 2 guests?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Send message' }).click();

    await expect(
      staff.getByRole('region', { name: 'Notifications' }).getByText('Sent to 0, skipped 2.'),
    ).toBeVisible();
    await expect(
      staff.getByTestId('broadcast').getByText(/running about 15 minutes/),
    ).toBeVisible();
    await expect(staff.getByText('Reached 0, skipped 2')).toBeVisible();
  });
});
