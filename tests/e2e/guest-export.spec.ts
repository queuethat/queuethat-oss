import { expect, test } from './fixtures.ts';

// 2B-C6 (#305): admins export the guest list from the Guests page. Import is in ee/.

test.describe('as owner', () => {
  test.use({ staffUser: 'owner' });

  test('export downloads a CSV', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/guests');
    const download = staff.waitForEvent('download');
    await staff.getByRole('button', { name: 'Export guests (CSV)' }).click();
    expect((await download).suggestedFilename()).toBe('guests.csv');
  });
});

test.describe('as staff', () => {
  test.use({ staffUser: 'staff' });

  test('AC2: staff see no export', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/guests');
    await expect(staff.getByRole('heading', { name: 'Guests' })).toBeVisible();
    await expect(staff.getByRole('button', { name: 'Export guests (CSV)' })).toHaveCount(0);
  });
});
