import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { NEW_ACCOUNT_PASSWORD, ownerOfNewBusiness, signInTo } from './support/accounts.ts';
import { totp } from './support/totp.ts';

// 2P-SEC2 (#206): authenticator apps for staff and admins, and the business-wide requirement.
test.use({ staffUser: null });

test('AC1, AC3: an owner enrols an app, then every later sign-in asks for a code before /admin', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/account/security');
  await expect(staff.getByRole('heading', { name: 'Account security' })).toBeVisible();
  await staff.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await staff.getByTestId('totp-secret').textContent())!.trim();
  await expectNoSeriousA11yViolations(staff);
  await staff.getByLabel('6-digit code').fill(totp(secret));
  await staff.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(staff.getByTestId('mfa-factors').getByText('Authenticator app 1')).toBeVisible();
  await expect(staff.getByText('Add a second authenticator app')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  const context = await browser.newContext();
  const later = await context.newPage();
  await later.goto('/auth/sign-in?next=%2Fadmin');
  await later.getByLabel('Email').fill(email);
  await later.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await later.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(later.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  expect(new URL(later.url()).pathname).toBe('/auth/mfa');
  await later.getByLabel('6-digit code').fill(totp(secret, 1));
  await later.getByRole('button', { name: 'Verify' }).click();
  await later.waitForURL((url) => url.pathname === '/admin');
  await context.close();
});

test('AC2: the owner turns the requirement on; without an app they see the enrolment banner', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/account/security');
  const toggle = staff.getByLabel('Require 2FA for owners and admins');
  await expect(toggle).toBeDisabled();
  await expect(staff.getByText('Verify with your authenticator app first')).toBeVisible();

  await staff.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await staff.getByTestId('totp-secret').textContent())!.trim();
  await staff.getByLabel('6-digit code').fill(totp(secret));
  await staff.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await staff.reload();
  await expect(staff.getByLabel('Require 2FA for owners and admins')).toBeChecked();

  // Removing the app leaves an owner below aal2 in a business that requires it: the banner explains.
  await staff.getByLabel('Current 6-digit code, to remove the app').fill(totp(secret, 1));
  await staff.getByRole('button', { name: 'Remove authenticator app' }).click();
  await staff.getByRole('button', { name: 'Remove app' }).click();
  await expect(staff.getByRole('button', { name: 'Set up authenticator app' })).toBeVisible();
  const banner = staff.getByTestId('mfa-required-banner');
  await expect(banner).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
  await banner.getByRole('link', { name: 'Set up an authenticator app' }).click();
  await expect(staff.getByRole('heading', { name: 'Account security' })).toBeVisible();
});
