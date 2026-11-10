import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// 2B-R8 (#299): managers read feedback trends and comments.
test.use({ staffUser: 'owner' });

test('feedback report renders tiles or the empty state and is axe clean', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/feedback');
  await expect(staff.getByRole('heading', { name: 'Guest feedback' })).toBeVisible();
  const tiles = staff.getByTestId('feedback-tiles');
  const empty = staff
    .getByText('No feedback in this range.')
    .or(staff.getByText('No feedback yet'));
  await expect(tiles.or(empty)).toBeVisible();
  await staff.getByLabel('From').fill('2030-01-01');
  await staff.getByLabel('To').fill('2030-01-31');
  await expect(empty).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});
