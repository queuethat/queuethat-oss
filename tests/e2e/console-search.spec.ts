import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST8 (#141): filter the live list and search guests.

test('AC1: a status filter narrows the list, persists across a reload, and clears', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Filter Fay', queue.id);
  await guestJoins('Filter Finn', queue.id);
  await openQueue(staff, queue.id);
  const waiting = staff.getByTestId('section-waiting').getByTestId('visit');
  await expect(waiting).toHaveCount(2);

  // Call one guest, then keep only the called ones.
  await staff.getByRole('button', { name: 'Call next' }).click();
  await expect(staff.getByTestId('section-called').getByTestId('visit')).toHaveCount(1);
  const filters = staff.getByRole('group', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Called', exact: true }).click();
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(0);
  await expect(staff.getByTestId('section-called').getByTestId('visit')).toHaveCount(1);

  await staff.reload();
  await expect(
    staff
      .getByRole('group', { name: 'Filters' })
      .getByRole('button', { name: 'Called', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  await staff.getByRole('button', { name: 'Clear filters' }).click();
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(1);
  await expectNoSeriousA11yViolations(staff);
});

test('AC2: searching a ticket number opens the matching visit in one tap', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Search Sue', queue.id);
  await guestJoins('Other Otto', queue.id);
  await openQueue(staff, queue.id);
  const ticket = (
    (await staff
      .getByTestId('section-waiting')
      .getByTestId('visit')
      .filter({ hasText: 'Search Sue' })
      .locator('span')
      .first()
      .textContent()) ?? ''
  ).trim();

  await staff.getByLabel('Search guests').fill(ticket);
  const hits = staff.getByRole('region', { name: 'Search results' }).getByTestId('search-hit');
  await expect(hits).toHaveCount(1);
  await hits.getByRole('button', { name: `Details for ${ticket}` }).click();
  await expect(staff.getByRole('dialog', { name: `Details for ${ticket}` })).toBeVisible();
});
