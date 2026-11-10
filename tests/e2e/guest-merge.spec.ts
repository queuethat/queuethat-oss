import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 2B-C4 (#303): admins review suggested duplicate guests and merge them.

test.use({ staffUser: 'owner' });

test('AC1: merging a suggested pair removes it and the survivor shows the combined visits', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const name = `Dana ${crypto.randomUUID().slice(0, 6)}`;
  // The same number typed with and without the country code: one guest each, same last nine digits.
  const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  await seedGuest(queue.id, name, `+1415${digits}`, 2);
  await seedGuest(queue.id, name, `+415${digits}`, 1);

  await staff.goto('/admin/guests/duplicates');
  await expect(staff.getByRole('heading', { name: 'Duplicate guests' })).toBeVisible();
  const pair = staff.getByTestId('duplicate-pair').filter({ hasText: name });
  await expect(pair).toHaveCount(1);
  await expect(pair.getByTestId('duplicate-side')).toHaveCount(2);
  await expectNoSeriousA11yViolations(staff);

  await pair.getByTestId('duplicate-side').first().getByRole('button', { name: /^Keep/ }).click();
  await staff.getByRole('dialog').getByRole('button', { name: 'Merge profiles' }).click();
  await expect(pair).toHaveCount(0);
  await expect(staff.getByText('Profiles merged.')).toBeVisible();

  await staff.goto('/admin/guests');
  await staff.getByLabel('Search by name, phone or email').fill(name);
  await staff.getByRole('link', { name: `Open ${name}` }).click();
  await expect(staff.getByTestId('guest-visit')).toHaveCount(3);
});

test.describe('as staff', () => {
  test.use({ staffUser: 'staff' });

  test('staff do not see the duplicates link', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/guests');
    await expect(staff.getByRole('heading', { name: 'Guests' })).toBeVisible();
    await expect(staff.getByRole('link', { name: 'Review duplicate guests' })).toHaveCount(0);
  });
});
