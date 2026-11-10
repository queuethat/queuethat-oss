import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-I8 (#313): owners add webhook endpoints, read the delivery log and redeliver.

function serviceClient() {
  const { serviceRoleKey, url } = supabaseEnv();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema('app');
}

test('staff cannot open the page', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/developers/webhooks');
  await expect(staff.getByText('Only admins and owners can manage webhooks.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Add endpoint' })).toHaveCount(0);
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('adds an endpoint, shows the secret once, rotates it and redelivers a failed delivery', async ({
    devices,
  }) => {
    const { staff } = devices;
    const url = `https://hooks.example.test/${crypto.randomUUID()}`;
    const db = serviceClient();
    try {
      await staff.goto('/admin/developers/webhooks');
      await staff.getByRole('button', { name: 'Add endpoint' }).click();
      const form = staff.getByRole('dialog', { name: 'Add a webhook endpoint' });
      await form.getByRole('textbox', { name: 'URL' }).fill(url);
      await expectNoSeriousA11yViolations(staff);
      await form.getByRole('button', { name: 'Add endpoint' }).click();

      const secret = await staff
        .getByTestId('shown-secret')
        .getByLabel('Signing secret')
        .inputValue();
      expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
      const done = staff.getByRole('button', { name: 'Done' });
      await expect(done).toBeDisabled();
      await staff.getByLabel('I have stored this secret').check();
      await done.click();

      const row = staff.getByTestId('webhook').filter({ hasText: url });
      await expect(row).toContainText('Active');
      await expect(staff.locator('body')).not.toContainText(secret);

      // Rotating shows a different secret, once.
      await row.getByRole('button', { name: `Rotate secret for ${url}` }).click();
      await staff
        .getByRole('dialog', { name: 'Rotate the signing secret?' })
        .getByRole('button', { name: 'Rotate secret' })
        .click();
      const rotated = await staff
        .getByTestId('shown-secret')
        .getByLabel('Signing secret')
        .inputValue();
      expect(rotated).toMatch(/^whsec_/);
      expect(rotated).not.toBe(secret);
      await staff.getByLabel('I have stored this secret').check();
      await staff.getByRole('button', { name: 'Done' }).click();

      // A failed delivery appears in the log, its payload opens, and redeliver queues it again.
      const { data: endpoint } = await db
        .from('webhook_endpoints')
        .select('id')
        .eq('url', url)
        .single();
      const { error } = await db.from('webhook_deliveries').insert({
        org_id: demo.orgId,
        endpoint_id: endpoint!.id,
        event_id: crypto.randomUUID(),
        event_type: 'visit.joined',
        payload: { type: 'visit.joined', marker: 'e2e-payload' },
        status: 'failed',
        attempts: 3,
        response_status: 500,
      });
      expect(error).toBeNull();
      await row.getByRole('button', { name: 'Deliveries' }).click();
      const delivery = row.getByTestId('delivery');
      await expect(delivery).toContainText('Failed');
      await expect(delivery).toContainText('HTTP 500');
      await delivery.getByRole('button', { name: 'Payload' }).click();
      await expect(staff.getByRole('dialog', { name: 'Payload' })).toContainText('e2e-payload');
      await staff.getByRole('button', { name: 'Close' }).click();
      await delivery.getByRole('button', { name: 'Redeliver' }).click();
      // Redelivering queues the delivery and adds a fresh queued one, so the log briefly holds
      // two rows: assert on a queued row rather than on a locator that must match exactly one.
      await expect(delivery.filter({ hasText: 'Queued' }).first()).toBeVisible();

      // AC1: "Send test event" puts a ping in the log (delivery itself needs the sender, #312).
      await row.getByRole('button', { name: 'Send test event' }).click();
      await expect(row.getByTestId('delivery').filter({ hasText: 'ping' })).toBeVisible();

      // AC2: a disabled endpoint is re-enabled and shows Active again.
      await db
        .from('webhook_endpoints')
        .update({ active: false, consecutive_failures: 5, disabled_reason: 'Too many failures' })
        .eq('url', url);
      await staff.reload();
      const disabled = staff.getByTestId('webhook').filter({ hasText: url });
      await expect(disabled).toContainText('Disabled');
      await disabled.getByRole('button', { name: 'Re-enable' }).click();
      await expect(disabled).toContainText('Active');
      await expect(disabled).not.toContainText('Too many failures');
    } finally {
      await db.from('webhook_endpoints').delete().eq('url', url);
    }
  });
});
