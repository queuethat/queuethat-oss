import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// DS-15 (#1019): a fresh owner sees the setup checklist on Today instead of six zero tiles.
test.use({ staffUser: null });

test('a fresh business sees the checklist, ticks the poster by hand and can hide it', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin');

  const list = staff.getByTestId('setup-checklist');
  await expect(list.getByRole('heading', { name: 'Get your line ready' })).toBeVisible();
  await expect(list.getByText('0 of 5 done')).toBeVisible();
  // No visit yet, so the zero tiles stay out of the way.
  await expect(staff.getByTestId('stat-waiting_now')).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);

  // Each step links to its page and never blocks navigation.
  await list.getByRole('link', { name: 'Set hours' }).click();
  await expect(staff).toHaveURL(/\/admin\/location\/hours$/);
  await staff.goBack();

  await list.getByRole('button', { name: "I've printed it" }).click();
  await expect(list.getByText('1 of 5 done')).toBeVisible();
  // Kept on the member's profile, so it survives a reload.
  await staff.reload();
  await expect(staff.getByTestId('setup-checklist').getByText('1 of 5 done')).toBeVisible();

  await staff.getByRole('button', { name: 'Hide checklist' }).click();
  await expect(staff.getByTestId('setup-checklist')).toHaveCount(0);
  await expect(staff.getByTestId('stat-waiting_now')).toBeVisible();
  await staff.reload();
  await expect(staff.getByTestId('stat-waiting_now')).toBeVisible();
  await expect(staff.getByTestId('setup-checklist')).toHaveCount(0);
});
