import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// 2P-PRV9 (#196): the owner schedules a business for deletion and can call it off.

test.use({ staffUser: null });

test('AC1: a typed slug mismatch keeps Delete disabled', async ({ devices }) => {
  const { staff } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/settings/danger');
  await expect(staff.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('button', { name: 'Delete this business' }).click();
  const dialog = staff.getByRole('dialog', { name: 'Delete this business?' });
  const confirm = dialog.getByRole('button', { name: 'Delete business' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type ${slug} to confirm`).fill(`${slug}-typo`);
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type ${slug} to confirm`).fill(slug);
  await expect(confirm).toBeEnabled();
});

test('AC2: a pending deletion shows the purge date and the owner can cancel', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email, slug } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/settings/danger');

  await staff.getByRole('button', { name: 'Delete this business' }).click();
  const dialog = staff.getByRole('dialog', { name: 'Delete this business?' });
  await dialog.getByLabel(`Type ${slug} to confirm`).fill(slug);
  await dialog.getByRole('button', { name: 'Delete business' }).click();

  await expect(staff.getByRole('heading', { name: 'Deletion is scheduled' })).toBeVisible();
  await expect(staff.getByTestId('purge-date')).toContainText('All data will be erased on');
  // The banner follows the owner across the admin, even though the business is locked.
  await expect(staff.getByTestId('deletion-banner')).toContainText('Deletion scheduled');
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('button', { name: 'Cancel deletion' }).first().click();
  await expect(staff.getByTestId('deletion-banner')).toHaveCount(0);
  await expect(staff.getByRole('heading', { name: 'Delete this business' })).toBeVisible();
});
