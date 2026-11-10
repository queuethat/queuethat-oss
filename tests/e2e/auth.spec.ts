import { DEMO_PASSWORD, demoUsers } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { confirmedAccount } from './support/accounts.ts';
import { authLinkFor, uniqueEmail } from './support/mail.ts';

// A1 (#41): staff sign-up, sign-in, emailed links and sign-out, driven through the screens.
test.use({ staffUser: null });

test('a new email signs up, opens the emailed link and lands signed in', async ({ devices }) => {
  const { staff } = devices;
  const email = uniqueEmail('signup');
  const since = new Date();

  await staff.goto('/auth/sign-up');
  await expectNoSeriousA11yViolations(staff);
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('status')).toContainText(`Check ${email}`);

  await staff.goto(await authLinkFor(email, since));
  // A brand-new account has no organization yet, so the staff guard sends it to onboarding.
  await expect(staff).toHaveURL(/\/onboarding$/);
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('a staff member signs in with a password, then signs out @core', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-in');
  await expectNoSeriousA11yViolations(staff);
  await staff.getByLabel('Email').fill(demoUsers.owner.email);
  await staff.getByLabel('Password').fill(DEMO_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(staff).toHaveURL(/\/staff$/);
  await staff.getByRole('button', { name: 'Sign out' }).click();
  await expect(staff).toHaveURL(/\/auth\/sign-in$/);
  await staff.goto('/staff');
  await expect(staff.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('a wrong password shows an error and stays on sign-in @core', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-in');
  await staff.getByLabel('Email').fill(demoUsers.owner.email);
  await staff.getByLabel('Password').fill('not-the-password');
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff.getByRole('alert')).toContainText("That email and password don't match");
  await expect(staff).toHaveURL(/\/auth\/sign-in$/);
});

test('an emailed sign-in link signs an existing account in and honours ?next', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const since = new Date();

  await staff.goto('/auth/sign-in?next=%2Fonboarding');
  await staff.getByLabel('Email').fill(email);
  await staff.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(staff.getByRole('status')).toContainText('sign-in code and link is on its way');

  await staff.goto(await authLinkFor(email, since));
  await expect(staff).toHaveURL(/\/onboarding$/);
  await expect(staff.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('an unknown email gets the same answer as a real one', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-in');
  await staff.getByLabel('Email').fill(uniqueEmail('nobody'));
  await staff.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(staff.getByRole('status')).toContainText('sign-in code and link is on its way');
});

test('a used or expired link explains itself', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto(
    '/auth/callback#error=access_denied&error_code=otp_expired&error_description=expired',
  );
  await expect(staff.getByRole('heading', { name: "That link didn't work" })).toBeVisible();
  await expect(staff.getByRole('alert')).toContainText('expired or was already used');
  await expectNoSeriousA11yViolations(staff);
});

test('?next pointing at another site is ignored', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-in?next=%2F%2Fevil.test');
  await staff.getByLabel('Email').fill(demoUsers.owner.email);
  await staff.getByLabel('Password').fill(DEMO_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff).toHaveURL(/localhost:\d+\/staff$/);
});

test('signing up with an existing email looks the same as a new one', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(demoUsers.owner.email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('status')).toContainText(`Check ${demoUsers.owner.email}`);
});

test('a link opened in another browser does not sign that browser in', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const email = uniqueEmail('elsewhere');
  const since = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill('a-long-password');
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('status')).toBeVisible();

  const other = await browser.newContext();
  const page = await other.newPage();
  await page.goto(await authLinkFor(email, since));
  await expect(page.getByRole('alert')).toContainText('same browser where you asked for it');
  await expect(page).toHaveURL(/\/auth\/callback/);
  await other.close();
});

test('tokens planted in a callback URL never sign anyone in', async ({ devices }) => {
  const { staff } = devices;
  const { url, anonKey } = supabaseEnv();
  // The attacker's own session, as a login-CSRF link would carry it (implicit-flow fragment).
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: demoUsers.otherOwner.email, password: DEMO_PASSWORD }),
  });
  const session = (await response.json()) as Record<string, string | number>;
  const fragment = new URLSearchParams({
    access_token: String(session.access_token),
    refresh_token: String(session.refresh_token),
    expires_in: String(session.expires_in),
    token_type: 'bearer',
    type: 'magiclink',
  });
  await staff.goto(`/auth/callback#${fragment}`);
  await expect(staff.getByRole('heading', { name: "That link didn't work" })).toBeVisible();
  await staff.goto('/staff');
  await expect(staff.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
