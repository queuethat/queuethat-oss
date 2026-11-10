import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 3-WA4 (#361): admins see which messages can go out on WhatsApp and fix missing mappings. The Meta
// sync itself is covered by the Deno test of whatsapp-templates-sync (the Graph API is faked there).

test.describe.configure({ mode: 'serial' });

/** Writes app rows with the service role, which a browser never holds. */
async function seed(path: string, init: RequestInit): Promise<unknown> {
  const { url, serviceRoleKey } = supabaseEnv();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'accept-profile': 'app',
      'content-profile': 'app',
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

test.beforeAll(async () => {
  // Cascades to the mappings, so reruns start clean.
  await seed(`notification_templates?org_id=eq.${demo.orgId}&channel=eq.whatsapp`, {
    method: 'DELETE',
  });
  const rows = (await seed('notification_templates', {
    method: 'POST',
    body: JSON.stringify([
      { org_id: demo.orgId, trigger: 'called', channel: 'whatsapp', body: 'Your turn {{ticket}}' },
      {
        org_id: demo.orgId,
        trigger: 'almost_up',
        channel: 'whatsapp',
        body: 'Almost up {{ticket}}',
      },
    ]),
  })) as Array<{ id: string; trigger: string }>;
  await seed('whatsapp_templates', {
    method: 'POST',
    body: JSON.stringify({
      org_id: demo.orgId,
      template_id: rows.find((r) => r.trigger === 'called')!.id,
      wa_name: 'queue_called',
      wa_language: 'en_US',
      wa_category: 'utility',
      status: 'rejected',
    }),
  });
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: a rejected template shows Rejected and cannot be mapped again', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.goto('/admin/whatsapp');
    await expect(staff.getByRole('heading', { name: 'WhatsApp', exact: true })).toBeVisible();
    const called = staff.getByTestId('wa-template').filter({ hasText: "You're called" });
    await expect(called).toContainText('queue_called');
    await expect(called).toContainText('Rejected');
    await expect(called.getByRole('button', { name: 'Map template' })).toHaveCount(0);
    await expect(
      called.getByRole('button', { name: 'Remove the mapping to queue_called' }),
    ).toBeVisible();
    // The warning: no approved template for "called".
    await expect(
      staff.getByRole('status').filter({ hasText: 'no approved template' }),
    ).toBeVisible();
    // The unmapped one can be mapped, and a category that disagrees with the message is refused.
    const almost = staff.getByTestId('wa-template').filter({ hasText: 'Almost up' });
    await almost.getByRole('button', { name: 'Map template' }).click();
    const dialog = staff.getByRole('dialog', { name: 'Map to a Meta template' });
    await dialog.getByLabel('Template name in Meta').fill('almost_up');
    await dialog.getByLabel('Category in Meta').selectOption('marketing');
    await dialog.getByRole('button', { name: 'Save mapping' }).click();
    await expect(dialog.getByRole('alert')).toContainText('does not match');
    await expectNoSeriousA11yViolations(staff);
  });
});

test.describe('as staff', () => {
  test('AC2: the page is read-only', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/whatsapp');
    const called = staff.getByTestId('wa-template').filter({ hasText: "You're called" });
    await expect(called).toContainText('Rejected');
    await expect(staff.getByText('Only admins and owners can change them.')).toBeVisible();
    for (const name of ['Sync from Meta', 'Map template', /^Remove/]) {
      await expect(staff.getByRole('button', { name })).toHaveCount(0);
    }
  });
});
