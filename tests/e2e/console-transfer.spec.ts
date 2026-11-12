import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST3 (#136): transfer a waiting guest to another queue.

test('AC1: a transfer puts the guest in the other queue within 3 s and their status page still works', async ({
  devices,
  browser,
}) => {
  const { staff, guest } = devices;
  const from = await freshQueue();
  const to = await freshQueue();
  const { token } = await guestJoins('Moving Mo', from.id);
  await openQueue(staff, from.id);
  const context = await browser.newContext({ viewport: staff.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');
  await openQueue(second, to.id);

  const row = staff.getByTestId('section-waiting').getByTestId('visit');
  const ticket = ((await row.locator('span').first().textContent()) ?? '').trim();
  await pickRowAction(row, 'Transfer', ticket);
  const dialog = staff.getByRole('dialog', { name: /^Transfer / });
  await expect(dialog).toContainText('keeps their place by join time');
  await dialog.getByLabel('To queue').selectOption({ label: to.name });
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Transfer', exact: true }).click();

  await expect(
    staff.getByRole('region', { name: 'Notifications' }).getByText(new RegExp(`to ${to.name}\\.$`)),
  ).toBeVisible();
  await expect(second.getByTestId('section-waiting')).toContainText('Moving Mo', {
    timeout: 3_000,
  });
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(0);

  await guest.goto(`/v/${token}`);
  await expect(guest.getByText(to.name)).toBeVisible();
  await context.close();
});
