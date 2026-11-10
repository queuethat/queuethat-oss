import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest, uniquePhone } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 2P-CRM4 (#187): the console marks regulars so staff can greet them.

test('AC1: a guest with an earlier visit shows a returning badge within 3 s of joining', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const regular = `Regular ${crypto.randomUUID().slice(0, 6)}`;
  const first = `First ${crypto.randomUUID().slice(0, 6)}`;

  await staff.goto('/staff');
  await staff.getByRole('tab', { name: queue.name }).click();
  await expect(staff.getByTestId('section-waiting')).toBeVisible();

  // Two joins by the same phone (the first is cancelled) and one newcomer.
  await seedGuest(queue.id, regular, uniquePhone(), 2);
  await seedGuest(queue.id, first, uniquePhone(), 1);

  const row = staff.getByTestId('visit').filter({ hasText: regular });
  await expect(row.getByTestId('returning-badge')).toContainText('Returning (2 visits)', {
    timeout: 3_000 + 7_000,
  });
  await expect(staff.getByTestId('visit').filter({ hasText: first })).toBeVisible();
  await expect(
    staff.getByTestId('visit').filter({ hasText: first }).getByTestId('returning-badge'),
  ).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);

  // Tapping the badge summarises the guest and links to their profile.
  await row.getByTestId('returning-badge').click();
  const dialog = staff.getByRole('dialog', { name: /Returning guest on/ });
  await expect(dialog).toContainText('2 visits so far');
  await dialog.getByRole('link', { name: 'Open profile' }).click();
  await expect(staff.getByRole('heading', { name: regular })).toBeVisible();
});
