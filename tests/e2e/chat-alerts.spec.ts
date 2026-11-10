import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-I11 (#316): owners connect a Slack, Discord or Teams channel and pick its alerts. The database
// only accepts the vendor's own webhook host, so the sender itself (Discord body, no HMAC headers) is
// covered by the deliver-webhooks Deno tests; here we check what the page saves and queues.

function serviceClient() {
  const { serviceRoleKey, url } = supabaseEnv();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema('app');
}

test('staff cannot connect a channel', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/developers/chat-alerts');
  await expect(staff.getByText('Only admins and owners can manage chat alerts.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Connect channel' })).toHaveCount(0);
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('connects Discord with a queue-long threshold of 5 and queues a test alert', async ({
    devices,
  }) => {
    const { staff } = devices;
    const url = `https://discord.com/api/webhooks/${Date.now()}/${crypto.randomUUID()}`;
    const db = serviceClient();
    try {
      await staff.goto('/admin/developers/chat-alerts');
      await staff.getByRole('combobox', { name: 'Chat app' }).selectOption('discord');
      await staff.getByRole('textbox', { name: 'Webhook URL' }).fill('https://example.com/nope');
      await staff.getByRole('button', { name: 'Connect channel' }).click();
      await expect(staff.getByRole('alert')).toContainText('not a discord.com webhook address');

      await staff.getByRole('textbox', { name: 'Webhook URL' }).fill(url);
      await staff.getByRole('checkbox', { name: 'The queue is long' }).check();
      await staff.getByRole('spinbutton', { name: /Queue is long when more than/ }).fill('5');
      await expectNoSeriousA11yViolations(staff);
      await staff.getByRole('button', { name: 'Connect channel' }).click();

      const row = staff.getByTestId('chat-alert').filter({ hasText: 'Queue over 5 waiting' });
      await expect(row).toContainText('Discord');
      await row.getByRole('button', { name: 'Send test alert' }).click();
      await expect(row.getByRole('status')).toContainText('Test alert queued');

      const { data: endpoint } = await db
        .from('webhook_endpoints')
        .select('id, kind, event_types, alert_thresholds')
        .eq('url', url)
        .single();
      expect(endpoint?.kind).toBe('discord');
      expect(endpoint?.alert_thresholds).toEqual({ waiting: 5 });
      expect(endpoint?.event_types).toEqual(expect.arrayContaining(['visit.joined', 'queue.long']));
      const { data: pings } = await db
        .from('webhook_deliveries')
        .select('event_type')
        .eq('endpoint_id', endpoint!.id)
        .eq('event_type', 'ping');
      expect(pings).toHaveLength(1);
    } finally {
      await db.from('webhook_endpoints').delete().eq('url', url);
    }
  });
});
