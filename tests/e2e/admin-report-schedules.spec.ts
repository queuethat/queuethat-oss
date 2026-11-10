import { createClient } from '@supabase/supabase-js';
import { mailpitEmailChannel } from '../../packages/providers/src/email.ts';
import { createRegistry } from '../../packages/providers/src/channel.ts';
import {
  dispatch,
  type OutboxJob,
} from '../../supabase/functions/dispatch-notifications/handler.ts';
import { eventually, expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { MAILPIT_URL } from './support/mail.ts';
import { testUsers } from './support/users.ts';

// 3-RPT2 (#369): the real dispatcher runs here in Node (no edge runtime in CI); the schedule rules
// themselves are covered in pgTAP.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Runs the real dispatcher over the owner's queued report emails. */
async function dispatchReports(to: string) {
  await dispatch({
    reserve: () => Promise.resolve('allowed'),
    async claim(limit, leaseSeconds) {
      const { data, error } = await service
        .schema('api')
        .rpc('claim_outbox', { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw error;
      // Other specs' rows stay leased and are claimed again when it runs out, as after a crash.
      return (data as OutboxJob[]).filter(
        (job) =>
          job.template_key === 'report_summary' &&
          (job.recipient as { value?: string } | null)?.value === to,
      );
    },
    stillRelevant: () => Promise.resolve(true),
    async report(outboxId, result) {
      const { error } = await service
        .schema('api')
        .rpc('report_outbox_result', { p_outbox_id: outboxId, p_result: result });
      if (error) throw error;
    },
    registry: createRegistry([
      mailpitEmailChannel({ baseUrl: MAILPIT_URL, from: { email: 'queue@localhost' } }),
    ]),
    secret: 'unused-by-dispatch-0123456789abcdef',
    log: () => {},
  });
}

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1 and AC2: creates a schedule, sees its next send time, and a preview reaches the mail catcher', async ({
    devices,
  }) => {
    const { staff } = devices;
    const since = new Date(Date.now() - 1000);
    try {
      await staff.goto('/admin/reports/schedules');
      await staff.getByRole('button', { name: 'New schedule' }).click();
      const form = staff.getByRole('dialog', { name: 'New report schedule' });
      await form.getByLabel('How often').selectOption('daily');
      await form.getByLabel('Send at (location time)').fill('08:30');
      await form.getByRole('group', { name: 'Recipients' }).getByRole('checkbox').first().check();
      await expectNoSeriousA11yViolations(staff);
      await form.getByRole('button', { name: 'Save schedule' }).click();

      const row = staff.getByTestId('schedule').first();
      await expect(row).toContainText('Every day at 08:30');
      await expect(row).toContainText(/Next report: .+\d{1,2}:30/);

      await row.getByRole('button', { name: /Send me a preview/ }).click();
      await expect(staff.getByText('Preview queued')).toBeVisible();

      const to = testUsers.owner.email;
      await dispatchReports(to);
      let subject = '';
      await eventually(async () => {
        const query = encodeURIComponent(`to:"${to}" subject:"queue report"`);
        const { messages } = (await (
          await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
        ).json()) as { messages: { Subject: string; Created: string }[] };
        subject = messages.find((m) => new Date(m.Created) >= since)?.Subject ?? '';
        return subject;
      }).toContain('daily queue report');
    } finally {
      await service
        .schema('app')
        .from('report_schedules')
        .delete()
        .eq('frequency', 'daily')
        .eq('send_at_local', '08:30:00');
    }
  });
});
