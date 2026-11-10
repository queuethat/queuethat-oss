import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST5 (#138): notes and tags on a visit, visible on every tablet.

test('AC1: a tag added on one tablet shows on another within 3 s', async ({ devices, browser }) => {
  const queue = await freshQueue();
  await guestJoins('Tagged Tess', queue.id);
  const first = devices.staff;
  const context = await browser.newContext({ viewport: first.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');
  for (const page of [first, second]) await openQueue(page, queue.id);

  await first.getByRole('button', { name: /^Details for / }).click();
  const dialog = first.getByRole('dialog', { name: /^Details for / });
  await expect(dialog).toContainText('Do not enter health details');
  await dialog.getByLabel('Notes').fill('Allergic to latex gloves');
  await expect(dialog).toContainText('24 of 1000 characters');
  await dialog.getByLabel('Add a tag').fill('VIP');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expectNoSeriousA11yViolations(first);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  for (const page of [first, second]) {
    const row = page.getByTestId('section-waiting').getByTestId('visit');
    await expect(row.getByTestId('row-tags')).toContainText('VIP', { timeout: 3_000 });
    await expect(row.getByLabel('Has a note')).toBeVisible();
  }

  // Today's tags come back as suggestions on the next guest, and the notes survive a reload.
  await guestJoins('Second Sam', queue.id);
  await expect(first.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(2);
  await first
    .getByRole('button', { name: /^Details for / })
    .last()
    .click();
  const next = first.getByRole('dialog', { name: /^Details for / });
  await expect(next.getByRole('group', { name: 'Tags used today' })).toContainText('VIP');
  await next.getByRole('button', { name: 'Cancel' }).click();
  await first.reload();
  await first
    .getByRole('button', { name: /^Details for / })
    .first()
    .click();
  await expect(first.getByLabel('Notes')).toHaveValue('Allergic to latex gloves');
  await context.close();
});
