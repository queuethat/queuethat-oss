import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD } from './support/accounts.ts';

// Change password for a signed-in user (#1076 follow-up): needs the current password.
// clock-ok: no clock arithmetic; specs here don't read the wall clock.
test.use({ staffUser: null });

const NEW_PASSWORD = 'a-brand-new-password';

async function signInAs(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signedIn(page: import('@playwright/test').Page) {
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('a signed-in user changes their password from the header link', async ({ devices }) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  await signInAs(staff, email, NEW_ACCOUNT_PASSWORD);
  await signedIn(staff);
  await staff.getByRole('link', { name: 'Change password' }).click();
  await expect(staff).toHaveURL(/\/auth\/change-password$/);
  await expectNoSeriousA11yViolations(staff);

  await staff.getByLabel('Current password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByLabel('New password').fill(NEW_PASSWORD);
  await staff.getByRole('button', { name: 'Change password' }).click();
  await expect(staff.getByRole('status')).toContainText('Your password was changed');

  // The auth screens have no header; Sign out lives on the app pages.
  await staff.getByRole('link', { name: 'Back to the app' }).click();
  await signedIn(staff);
  await staff.getByRole('button', { name: 'Sign out' }).click();
  // Signing out navigates to sign-in by itself; a goto in signInAs would race it.
  await expect(staff).toHaveURL(/\/auth\/sign-in/);
  await signInAs(staff, email, NEW_ACCOUNT_PASSWORD);
  await expect(staff.getByRole('alert')).toContainText("That email and password don't match");
  await staff.getByLabel('Password').fill(NEW_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('a wrong current password changes nothing', async ({ devices }) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  await signInAs(staff, email, NEW_ACCOUNT_PASSWORD);
  await signedIn(staff);
  await staff.getByRole('link', { name: 'Change password' }).click();
  await staff.getByLabel('Current password').fill('not-the-password');
  await staff.getByLabel('New password').fill(NEW_PASSWORD);
  await staff.getByRole('button', { name: 'Change password' }).click();
  await expect(staff.getByRole('alert')).toContainText('not your current password');
});

test('signed-out visitors are sent to sign-in', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/change-password');
  await expect(staff).toHaveURL(/\/auth\/sign-in/);
});
