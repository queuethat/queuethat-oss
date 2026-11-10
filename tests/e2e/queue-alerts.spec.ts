import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';

// N-8 (#133): owners choose which alerts a queue offers; staff only see the choice.

test('staff see which alerts a queue offers but cannot change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/queues');
  await expect(staff.getByTestId('queue-alerts').first()).toContainText('Guest alerts:');
  await expect(staff.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC1: switching served on saves it on the queue and writes an audit row', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/queues');
    await staff.getByRole('button', { name: 'Add a queue' }).click();
    await staff.getByLabel('Queue name').fill('Alerts');
    await staff.getByRole('button', { name: 'Save queue' }).click();
    await expect(staff.getByTestId('queue-alerts')).not.toContainText('Visit finished');

    await staff.getByRole('button', { name: 'Edit' }).click();
    const served = staff.getByLabel('Visit finished');
    await expect(served).not.toBeChecked();
    await expect(staff.getByText(/Example: Thanks for visiting/)).toBeVisible();
    await staff.getByLabel('Almost up at').fill('4');
    await served.check();
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save queue' }).click();
    await expect(staff.getByTestId('queue-alerts')).toContainText('Visit finished');

    const [queues, audit] = (await readAs(email, [
      'queues?select=notify_triggers,almost_up_threshold',
      'audit_log?select=after&table_name=eq.queues&action=eq.UPDATE',
    ])) as [
      { notify_triggers: string[]; almost_up_threshold: number }[],
      { after: { notify_triggers: string[] } }[],
    ];
    expect(queues[0]!.notify_triggers).toContain('served');
    expect(queues[0]!.almost_up_threshold).toBe(4);
    expect(audit.some((row) => row.after.notify_triggers.includes('served'))).toBe(true);
  });
});
