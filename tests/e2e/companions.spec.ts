import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2B-J6 (#244): a guest adds a companion; staff see the party size and the name within 3 s.

test('AC1: a companion added by the guest shows on the staff console', async ({ devices }) => {
  const queue = await freshQueue();
  const { token } = await guestJoins('Party Pat', queue.id);
  const { guest, staff } = devices;
  await openQueue(staff, queue.id);
  await guest.goto(`/v/${token}`);

  await guest.getByLabel('First name').fill('Maya');
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Add someone' }).click();
  await expect(guest.getByRole('list').getByText('Maya')).toBeVisible();

  const row = staff.getByTestId('section-waiting').getByTestId('visit');
  await expect(row).toContainText('2', { timeout: 3_000 });
  await pickRowAction(staff, 'Details');
  await expect(staff.getByRole('button', { name: 'Remove Maya' })).toBeVisible({ timeout: 3_000 });

  // The guest removes Maya again, after the small confirm.
  await guest.getByRole('button', { name: 'Remove Maya' }).click();
  await guest.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(guest.getByText('No one added yet.')).toBeVisible();
});
