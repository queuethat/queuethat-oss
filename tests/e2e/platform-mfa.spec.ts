import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD, signInTo } from './support/accounts.ts';
import { enrol, newOperator, platformRpcStatus, totp } from './support/totp.ts';
import type { Page } from '@playwright/test';

// PLT11 (#417): platform operators add an authenticator app and reach aal2 at /platform/mfa.
test.use({ staffUser: null });

async function signInAgain(page: Page, email: string) {
  await page.goto('/auth/sign-in?next=/platform/mfa');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
}

test('AC1: an operator without a factor enrols and reaches aal2; next time they get a challenge', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const email = await newOperator();
  await signInTo(staff, email, '/platform/mfa');
  await expect(staff.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
  expect(await platformRpcStatus(staff)).toBe(403);

  const secret = await enrol(staff);
  expect(await platformRpcStatus(staff), 'the session is aal2 now').toBe(200);

  const context = await browser.newContext();
  const later = await context.newPage();
  await signInAgain(later, email);
  await expectNoSeriousA11yViolations(later);
  expect(await platformRpcStatus(later)).toBe(403);
  // The next step's code: Auth accepts one step of clock skew, and this one hasn't been used.
  await later.getByLabel('6-digit code').fill(totp(secret, 1));
  await later.getByRole('button', { name: 'Verify' }).click();
  await expect(later.getByRole('heading', { name: 'Two-step sign-in is on' })).toBeVisible();
  expect(await platformRpcStatus(later)).toBe(200);
  await context.close();
});

test('AC2: five wrong codes lock the account, and no session is upgraded', async ({ devices }) => {
  const { staff } = devices;
  const email = await newOperator();
  await signInTo(staff, email, '/platform/mfa');
  const secret = await enrol(staff);
  await signInAgain(staff, email);

  const valid = new Set([-1, 0, 1, 2].map((step) => totp(secret, step)));
  const wrong = ['000000', '111111', '222222'].find((code) => !valid.has(code))!;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await staff.getByLabel('6-digit code').fill(wrong);
    await staff.getByRole('button', { name: 'Verify' }).click();
    await expect(staff.getByText('That code is wrong or has expired.')).toBeVisible();
    expect(await platformRpcStatus(staff)).toBe(403);
  }
  await staff.getByLabel('6-digit code').fill(wrong);
  await staff.getByRole('button', { name: 'Verify' }).click();
  await expect(staff.getByText('Too many wrong codes, so you have been signed out.')).toBeVisible();
  // Locked means the account, not the session: after signing in again, the right code is
  // refused too, and that session is ended as well.
  await signInAgain(staff, email);
  await staff.getByLabel('6-digit code').fill(totp(secret, 1));
  await staff.getByRole('button', { name: 'Verify' }).click();
  await expect(staff.getByText('Too many wrong codes, so you have been signed out.')).toBeVisible();
  expect(await staff.evaluate(() => localStorage.getItem('qm.auth'))).toBeNull();
});

test('an operator can remove the app after a fresh code', async ({ devices }) => {
  const { staff } = devices;
  const email = await newOperator();
  await signInTo(staff, email, '/platform/mfa');
  const secret = await enrol(staff);
  await staff.getByLabel('Current 6-digit code, to remove the app').fill(totp(secret, 1));
  await staff.getByRole('button', { name: 'Remove authenticator app' }).click();
  await staff.getByRole('button', { name: 'Remove app' }).click();
  await expect(staff.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
});

test('anyone signed in can set up the app before being given a platform role', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  await signInTo(staff, email, '/platform/mfa');
  await expect(staff.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await enrol(staff);
  // Still no platform access: the role is what platform RPCs check, alongside aal2.
  expect(await platformRpcStatus(staff)).toBe(403);
});
