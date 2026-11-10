import { demoUsers } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST14 (#147): assign a waiting guest to a person; only their Call next picks the guest.

test('AC1: a guest assigned to another person is skipped by Call next and keeps the badge', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Assigned Alpha', queue.id);
  await guestJoins('Open Bravo', queue.id);
  const context = await browser.newContext({ viewport: staff.viewportSize() });
  const owner = await context.newPage();
  await signIn(owner, 'owner');
  await openQueue(staff, queue.id);
  await openQueue(owner, queue.id);

  const alpha = (page: typeof staff) =>
    page.getByTestId('section-waiting').getByTestId('visit').filter({ hasText: 'Assigned Alpha' });
  const ticket = ((await alpha(staff).locator('span').first().textContent()) ?? '').trim();
  await alpha(staff)
    .getByRole('button', { name: `Assign ${ticket}` })
    .click();
  const dialog = staff.getByRole('dialog', { name: `Assign ${ticket}` });
  await dialog.getByLabel('Person').selectOption(demoUsers.e2eOwner.id);
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Everyone sees who the guest is for.
  for (const page of [staff, owner]) {
    await expect(alpha(page).getByTestId('assignee-badge')).toContainText('For ', {
      timeout: 3_000,
    });
  }

  // The other person's Call next takes the open guest; the assigned one stays, badge and all.
  await staff.getByRole('button', { name: 'Call next' }).click();
  await expect(staff.getByTestId('section-called')).toContainText('Open Bravo');
  await expect(alpha(staff).getByTestId('assignee-badge')).toBeVisible();

  // "Mine" on the assignee's tablet shows just their guest; on the other it shows none.
  await owner.getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(alpha(owner)).toHaveCount(1);
  await staff.getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(alpha(staff)).toHaveCount(0);

  // Unassign opens the guest to everyone again.
  await staff.getByRole('button', { name: 'Clear filters' }).click();
  await alpha(staff)
    .getByRole('button', { name: `Assign ${ticket}` })
    .click();
  await staff
    .getByRole('dialog', { name: `Assign ${ticket}` })
    .getByRole('button', { name: 'Unassign' })
    .click();
  await expect(alpha(staff).getByTestId('assignee-badge')).toHaveCount(0);
  await context.close();
});
