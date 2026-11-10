import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD } from './support/accounts.ts';
import { authCodeFor, authLinkFor, uniqueEmail } from './support/mail.ts';

// Forgot password (#1076): a recovery email carries an 8-digit code and a PKCE link; either ends on
// /auth/reset-password with a session that can set a new password.
// clock-ok: `new Date()` only marks which email is new; it is compared with mail timestamps, not a location day.
test.use({ staffUser: null });

const NEW_PASSWORD = 'a-brand-new-password';

test('sign-in links to the reset screen', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-in');
  await staff.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(staff).toHaveURL(/\/auth\/forgot-password$/);
  await expectNoSeriousA11yViolations(staff);
});

test('the code from a reset email lets the person choose a new password and sign in with it', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  await staff.goto('/auth/forgot-password');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a reset code' }).click();
  await expect(staff.getByRole('status')).toContainText(`If ${email} has an account`);

  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, since));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff).toHaveURL(/\/auth\/reset-password$/);
  await expectNoSeriousA11yViolations(staff);

  await staff.getByLabel('New password').fill(NEW_PASSWORD);
  await staff.getByRole('button', { name: 'Save new password' }).click();
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // The old password no longer works; the new one does.
  await staff.getByRole('button', { name: 'Sign out' }).click();
  // Signing out navigates to sign-in by itself; a goto here would race it.
  await expect(staff).toHaveURL(/\/auth\/sign-in/);
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff.getByRole('alert')).toContainText("That email and password don't match");
  await staff.getByLabel('Password').fill(NEW_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('the emailed link, opened in the same browser, reaches the reset screen', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  await staff.goto('/auth/forgot-password');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a reset code' }).click();
  await staff.goto(await authLinkFor(email, since));
  await expect(staff).toHaveURL(/\/auth\/reset-password$/);
  await staff.getByLabel('New password').fill(NEW_PASSWORD);
  await staff.getByRole('button', { name: 'Save new password' }).click();
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('the current password is refused and an unknown email gets the same answer as a known one', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  await staff.goto('/auth/forgot-password');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a reset code' }).click();
  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, since));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await staff.getByLabel('New password').fill(NEW_ACCOUNT_PASSWORD); // the current password
  await staff.getByRole('button', { name: 'Save new password' }).click();
  await expect(staff.getByRole('alert')).toContainText('current password');

  const stranger = uniqueEmail('nobody');
  await staff.goto('/auth/forgot-password');
  await staff.getByLabel('Email').fill(stranger);
  await staff.getByRole('button', { name: 'Email me a reset code' }).click();
  await expect(staff.getByRole('status')).toContainText(`If ${stranger} has an account`);
});

test('a wrong code is refused and the reset screen needs a recovery session', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  await staff.goto('/auth/forgot-password');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a reset code' }).click();
  const real = await authCodeFor(email, since);
  const wrong = String((Number(real) + 1) % 10 ** real.length).padStart(real.length, '0');
  await staff.getByLabel('8-digit code').fill(wrong);
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff.getByText('That code is wrong, already used or expired.')).toBeVisible();

  await staff.goto('/auth/reset-password');
  await expect(staff.getByRole('alert')).toContainText('no longer valid');
});
