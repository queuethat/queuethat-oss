import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST6 (#139): a visit's history, from its row and from "Done today".

test('AC1: an undone call is struck through with who undid it, and finished visits keep their history', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('History Hana', queue.id);
  await openQueue(staff, queue.id);
  const row = staff.getByTestId('section-waiting').getByTestId('visit');
  const ticket = ((await row.locator('span').first().textContent()) ?? '').trim();

  await staff.getByRole('button', { name: `Call ${ticket}` }).click();
  await staff
    .getByRole('region', { name: 'Notifications' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(staff.getByTestId('section-waiting')).toContainText('History Hana');

  await pickRowAction(staff, 'History', ticket);
  const drawer = staff.getByRole('dialog', { name: `History of ${ticket}` });
  const entries = drawer.getByTestId('history-entry');
  await expect(entries.filter({ hasText: 'Joined the line' })).toHaveCount(1);
  const call = entries.filter({ hasText: 'Called' }).first();
  await expect(call.locator('.line-through')).toContainText('Called');
  await expect(call).toContainText(/undone by .+/);
  await expectNoSeriousA11yViolations(staff);
  await drawer.getByRole('button', { name: 'Close' }).click();

  // Finish the visit; it leaves the lists but stays reachable under "Done today".
  await staff.getByRole('button', { name: `Call ${ticket}` }).click();
  await staff.getByRole('button', { name: `Start ${ticket}` }).click();
  await staff.getByRole('button', { name: `Done with ${ticket}` }).click();
  const done = staff
    .getByTestId('section-done')
    .getByTestId('done-visit')
    .filter({ hasText: ticket });
  await expect(done).toContainText('Served');
  await done.getByRole('button', { name: `History of ${ticket}` }).click();
  await expect(
    staff
      .getByRole('dialog', { name: `History of ${ticket}` })
      .getByTestId('history-entry')
      .filter({ hasText: 'Finished' }),
  ).toHaveCount(1);
});
