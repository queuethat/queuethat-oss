import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { confirmedAccount } from './support/accounts.ts';
import { authCodeFor, authLinkFor, uniqueEmail } from './support/mail.ts';

// A1 follow-up: emails carry a 8-digit code as well as the link. The link only works in the
// browser that asked (PKCE); the code works wherever the person types it.
test.use({ staffUser: null });

test('the code from a sign-in email signs an existing account in', async ({ devices }) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  await staff.goto('/auth/sign-in?next=%2Fonboarding');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(staff.getByLabel('8-digit code')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, since));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff).toHaveURL(/\/onboarding$/);
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('after the link opens on another device, a sign-in code gets this browser in', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const email = uniqueEmail('code');
  const since = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('status')).toContainText(`Check ${email} for a code`);

  // Opening the link on a phone confirms the address but signs neither device in.
  const phone = await browser.newContext();
  const page = await phone.newPage();
  await page.goto(await authLinkFor(email, since));
  await expect(page.getByRole('alert')).toContainText('same browser where you asked for it');
  await phone.close();

  // The confirmation code went with the link, so this browser asks for a sign-in code.
  const again = new Date();
  await staff.goto('/auth/sign-in');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, again));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff).toHaveURL(/\/onboarding$/);
});

test('the code from a confirmation email confirms and signs in', async ({ devices }) => {
  const { staff } = devices;
  const email = uniqueEmail('confirm');
  const since = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, since));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff).toHaveURL(/\/onboarding$/);
});

test('a wrong code is refused and nobody is signed in', async ({ devices }) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();
  await staff.goto('/auth/sign-in');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const real = await authCodeFor(email, since);
  const wrong = String((Number(real) + 1) % 10 ** real.length).padStart(real.length, '0');
  await staff.getByLabel('8-digit code').fill(wrong);
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff.getByText('That code is wrong, already used or expired.')).toBeVisible();
  await expect(staff).toHaveURL(/\/auth\/sign-in/);
  await expect(staff.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

// S2 (#1106): the same words and the same resend whether or not the address has an account.
test('a new address can ask for the confirmation email again after the wait', async ({
  devices,
}) => {
  const { staff } = devices;
  await staff.clock.install();
  const email = uniqueEmail('resend');
  const since = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await authCodeFor(email, since);
  await expect(staff.getByRole('button', { name: 'Resend email' })).toBeDisabled();

  await staff.clock.runFor(61_000);
  // The local Auth server (not the browser clock) allows one confirmation email a second.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const again = new Date();
  await staff.getByRole('button', { name: 'Resend email' }).click();
  await expect(staff.getByText('Sent again')).toBeVisible();
  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, again));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff).toHaveURL(/\/onboarding$/);
});

test('an address that already has an account is pointed at sign-in', async ({ devices }) => {
  const { staff } = devices;
  await staff.clock.install();
  const email = await confirmedAccount();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('another-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('status').first()).toContainText(`Check ${email} for a code`);
  await staff.clock.runFor(61_000);
  await expect(staff.getByText('If you may already have an account')).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
  await staff.getByRole('link', { name: 'Sign in instead' }).click();
  await expect(staff).toHaveURL(/\/auth\/sign-in/);
});

// S4 (#1107): an account that never confirmed can resend from the sign-in page.
test('an unconfirmed account can resend the confirmation and finish with the code', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = uniqueEmail('unconfirmed');
  const signedUp = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await authCodeFor(email, signedUp);

  await staff.goto('/auth/sign-in');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff.getByRole('alert')).toContainText('Confirm your email first');
  // The local Auth server allows one confirmation email a second.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const again = new Date();
  await staff.getByRole('button', { name: 'Resend confirmation email' }).click();
  await staff.getByLabel('8-digit code').fill(await authCodeFor(email, again));
  await staff.getByRole('button', { name: 'Continue with code' }).click();
  await expect(staff).toHaveURL(/\/staff|\/onboarding/);
});

// S8 (#1109): the emailed link fails in a phone's in-app browser; a fresh code asked for on
// the failure screen finishes the job right there.
test('a link that fails in this browser still signs in with a fresh code asked for on that screen', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const email = uniqueEmail('callback-code');
  const since = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('status')).toBeVisible();

  const phone = await browser.newContext();
  const page = await phone.newPage();
  await page.goto(await authLinkFor(email, since));
  await expect(page.getByRole('alert')).toContainText('same browser where you asked for it');
  // Opening the link used up its code too, so the screen asks for a new one.
  await page.getByLabel('Email').fill(email);
  const fresh = new Date();
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('8-digit code').fill(await authCodeFor(email, fresh));
  await page.getByRole('button', { name: 'Continue with code' }).click();
  await expect(page).toHaveURL(/\/(onboarding|staff)/);
  await phone.close();
});
