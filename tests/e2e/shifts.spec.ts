import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { signIn } from './support/auth.ts';

// 2B-ORG6 (#270): a manager plans a shift across midnight; it is one block, on the day it starts,
// in the week grid (tablet) and in the list (phone).

test.use({ staffUser: 'owner' });

test('AC1: a 22:00-02:00 shift is one block; AC2: the list view has no serious a11y problems', async ({
  devices,
}) => {
  const { staff, guest } = devices;
  await staff.goto('/admin/shifts');
  await expect(staff.getByRole('heading', { name: 'Shifts' })).toBeVisible();

  await staff.getByRole('button', { name: 'Add shift' }).click();
  const dialog = staff.getByRole('dialog', { name: 'Add shift' });
  await dialog.getByLabel('Day').fill(new Date().toISOString().slice(0, 10));
  await dialog.getByLabel('Starts').fill('22:00');
  await dialog.getByLabel('Ends').fill('02:00');
  await dialog.getByLabel('Note').fill('Late cover');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  const blocks = staff.getByRole('button', { name: /10:00 PM to 2:00 AM \+1/ });
  await expect(blocks).toHaveCount(1);

  // Phone: the list view.
  await signIn(guest, 'owner');
  await guest.goto('/admin/shifts');
  const list = guest.getByTestId('shift-list');
  await expect(list.getByRole('button', { name: /10:00 PM to 2:00 AM \+1/ })).toHaveCount(1);
  await expectNoSeriousA11yViolations(guest);

  // Clean up through the destructive confirmation.
  await blocks.click();
  await staff.getByRole('button', { name: 'Delete shift' }).click();
  await staff
    .getByRole('dialog', { name: 'Delete this shift?' })
    .getByRole('button', { name: 'Delete shift' })
    .click();
  await expect(blocks).toHaveCount(0);
});
