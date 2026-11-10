import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 3-PV3 (#342): the provider settings page. Real calls go to the local Supabase; no provider is
// contacted (the webhook URL is only displayed). The database rules are in pgTAP.

const TOKEN = 'tok_e2e_secret_value_4821';

function serviceClient() {
  const { serviceRoleKey, url } = supabaseEnv();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema('app');
}

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });
  // both tests rewrite the demo org's SMS settings
  test.describe.configure({ mode: 'serial' });

  test('#921: each SMS provider asks for its own credentials', async ({ devices }) => {
    const { staff } = devices;
    const db = serviceClient();
    await db.from('provider_settings').delete().eq('org_id', demo.orgId).eq('channel', 'sms');
    try {
      await staff.goto('/admin/integrations');
      const card = staff.getByTestId('channel-sms');
      await card.getByLabel('Provider').selectOption('telnyx');
      await expect(card.getByLabel('Messaging profile ID')).toBeVisible();
      await expect(card.getByLabel('API key')).toBeVisible();
      await expect(card.getByLabel('Webhook public key')).toBeVisible();
      await expect(card.getByLabel('Auth token')).toHaveCount(0);
      await card.getByLabel('Provider').selectOption('vonage');
      await expect(card.getByLabel('API secret')).toBeVisible();
      await expect(card.getByLabel('Webhook signature secret')).toBeVisible();
      await card.getByLabel('Provider').selectOption('plivo');
      await expect(card.getByLabel('Auth ID')).toBeVisible();
      await expect(card.getByLabel('Auth token')).toBeVisible();
      await card.getByLabel('Provider').selectOption('telnyx');
      await card.getByLabel('Messaging profile ID').fill('prof-e2e');
      await card.getByLabel('API key', { exact: true }).fill('telnyx-key-e2e-7777');
      await card.getByRole('button', { name: 'Save' }).click();
      await expect(card.getByLabel('Webhook URL')).toHaveValue(
        /\/provider-webhook\/telnyx\/[0-9a-f-]{36}$/,
      );
      await staff.reload();
      await expect(staff.getByTestId('channel-sms').getByText('Saved as ****7777')).toBeVisible();
    } finally {
      await db.from('provider_settings').delete().eq('org_id', demo.orgId).eq('channel', 'sms');
    }
  });

  test('AC1 and AC2: a saved secret shows only its last four characters, and enabling lists what is missing', async ({
    devices,
  }) => {
    const { staff } = devices;
    const db = serviceClient();
    await db.from('provider_settings').delete().eq('org_id', demo.orgId).eq('channel', 'sms');
    const bodies: string[] = [];
    staff.on('response', async (res) => {
      if (res.url().includes('provider_settings') || res.url().includes('set_provider_settings')) {
        bodies.push(await res.text().catch(() => ''));
      }
    });
    try {
      await staff.goto('/admin/integrations');
      const card = staff.getByTestId('channel-sms');
      await card.getByLabel('Auth token').fill(TOKEN);
      await card.getByLabel('Sending phone number').fill('+15005550006');
      await expectNoSeriousA11yViolations(staff);
      await card.getByRole('button', { name: 'Save' }).click();
      await expect(card.getByLabel('Webhook URL')).toHaveValue(
        /\/provider-webhook\/twilio\/[0-9a-f-]{36}$/,
      );
      await expect(card.getByTestId('verified-sms')).toContainText('Waiting');

      await staff.reload();
      const reloaded = staff.getByTestId('channel-sms');
      await expect(reloaded.getByLabel('Auth token')).toHaveValue('');
      await expect(reloaded.getByText('Saved as ****4821')).toBeVisible();
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.join('\n')).not.toContain(TOKEN);

      await reloaded.getByLabel('Turn this channel on').click();
      const missing = reloaded.getByTestId('missing-sms');
      await expect(missing).toContainText('compliance check');
      await expect(missing).toContainText('signed test event');
      await expect(reloaded.getByLabel('Turn this channel on')).not.toBeChecked();
    } finally {
      await db.from('provider_settings').delete().eq('org_id', demo.orgId).eq('channel', 'sms');
    }
  });
});

test.describe('as staff', () => {
  test.use({ staffUser: 'staff' });

  test('AC3: every input is read-only and there is nothing to save', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/integrations');
    await expect(
      staff.getByText('Only admins and owners can change provider settings'),
    ).toBeVisible();
    const card = staff.getByTestId('channel-sms');
    await expect(card.getByLabel('Provider')).toBeDisabled();
    await expect(card.getByLabel('Sending phone number')).not.toBeEditable();
    await expect(card.getByLabel('Auth token')).not.toBeEditable();
    await expect(card.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(card.getByLabel('Turn this channel on')).toHaveCount(0);
  });
});
