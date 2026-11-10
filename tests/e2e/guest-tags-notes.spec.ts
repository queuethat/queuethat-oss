import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest, uniquePhone } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 2B-C2 (#301): tags and notes on a guest profile; tag chips on the console row.

test.use({ staffUser: 'owner' });

test('AC1: a guest tagged VIP shows the chip on the console row when they join again', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const name = `Regular ${crypto.randomUUID().slice(0, 6)}`;
  const phone = uniquePhone();
  const tag = `VIP ${crypto.randomUUID().slice(0, 4)}`;
  await seedGuest(queue.id, name, phone, 1);

  await staff.goto('/admin/guests');
  await staff.getByLabel('Search by name, phone or email').fill(name);
  await staff.getByRole('link', { name: `Open ${name}` }).click();
  await expect(staff.getByRole('heading', { name })).toBeVisible();

  await staff.getByLabel('Add a tag').fill(tag);
  await staff.getByRole('button', { name: 'Add tag' }).click();
  await expect(staff.getByTestId('guest-tag').filter({ hasText: tag })).toHaveCount(1);

  await staff.getByLabel('Add a note').fill('Prefers the window seat');
  await staff.getByRole('button', { name: 'Add note' }).click();
  const note = staff.getByTestId('guest-note').filter({ hasText: 'Prefers the window seat' });
  await expect(note).toHaveCount(1);
  await expect(staff.getByText('Do not record health information in notes.')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  // The guest joins again: the new visit's row carries the chip, as text.
  await seedGuest(queue.id, name, phone, 1);
  await staff.goto('/staff');
  await staff.getByRole('tab', { name: queue.name }).click();
  const rows = staff.getByTestId('visit').filter({ hasText: name });
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByTestId('guest-tag-chip')).toHaveText(tag);

  // Notes delete softly, after a confirmation.
  await staff.goto('/admin/guests');
  await staff.getByLabel('Search by name, phone or email').fill(name);
  await staff.getByRole('link', { name: `Open ${name}` }).click();
  await staff
    .getByTestId('guest-note')
    .getByRole('button', { name: /^Delete note/ })
    .click();
  await staff.getByRole('dialog').getByRole('button', { name: 'Delete note' }).click();
  await expect(staff.getByTestId('guest-note')).toHaveCount(0);
});
