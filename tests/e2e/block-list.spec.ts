import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest, tryStaffAdd, uniquePhone } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 2P-PRV6 (#193): managers remove and block a fake joiner, and lift the block later.

test.use({ staffUser: 'owner' });

test('AC1+AC2: a blocked phone cannot rejoin until the block is lifted', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const name = `Prank ${crypto.randomUUID().slice(0, 6)}`;
  const phone = uniquePhone();
  const reason = `fake join ${crypto.randomUUID().slice(0, 6)}`;
  await seedGuest(queue.id, name, phone, 1);

  await staff.goto('/staff');
  await staff.getByRole('tab', { name: queue.name }).click();
  const row = staff.getByTestId('visit').filter({ hasText: name });
  await row.getByRole('button', { name: /^Remove and block/ }).click();
  const dialog = staff.getByRole('dialog', { name: /^Remove and block/ });
  const confirm = dialog.getByRole('button', { name: 'Remove and block' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Reason').fill(reason);
  await dialog.getByLabel('Block for').selectOption('month');
  await confirm.click();
  await expect(row).toHaveCount(0);

  // AC1: the same phone is refused.
  expect(await tryStaffAdd(queue.id, name, phone)).toBe('guest_blocked');

  await staff.goto('/admin/blocks');
  await expect(staff.getByRole('heading', { name: 'Blocks' })).toBeVisible();
  const block = staff.getByTestId('block').filter({ hasText: reason }).first();
  await expect(block).toContainText('Phone');
  await expect(block).toContainText('until');
  await expectNoSeriousA11yViolations(staff);

  // AC2: lifting every block of this visit lets the phone back in.
  const mine = staff.getByTestId('block').filter({ hasText: reason });
  for (let left = await mine.count(); left > 0; left--) {
    await mine
      .first()
      .getByRole('button', { name: /^Unblock/ })
      .click();
    await expect(mine).toHaveCount(left - 1);
  }
  expect(await tryStaffAdd(queue.id, name, phone)).toBeNull();
});
