import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// 2B-R6 (#297): owners see locations side by side; single-location orgs never see the report.
test.use({ staffUser: 'owner' });

test('AC1: one location means no navigation entry; the page still renders and is axe clean', async ({
  devices,
}) => {
  const { staff } = devices;
  await staff.goto('/admin');
  await expect(staff.getByRole('heading').first()).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Compare locations' })).toHaveCount(0);

  await staff.goto('/admin/comparison');
  await expect(staff.getByRole('heading', { name: 'Compare locations' })).toBeVisible();
  await expect(
    staff.getByRole('table').or(staff.getByText('No locations to compare.')),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});
