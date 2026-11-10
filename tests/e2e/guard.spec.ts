import { DEMO_PASSWORD, demoUsers } from '../fixtures/demo.ts';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD } from './support/accounts.ts';

// The header names the working location as text, or as a picker once the org has a second one.
// Other specs add locations to the demo org (support/booking.ts) and leave them, so accept both.
async function workingLocation(page: Page): Promise<string> {
  const text = page.getByTestId('current-location');
  const picker = page.getByLabel('Location', { exact: true });
  await expect(text.or(picker)).toBeVisible();
  return (await text.count())
    ? ((await text.textContent()) ?? '')
    : ((await picker.locator('option:checked').textContent()) ?? '');
}

// A2 (#42): who may enter /staff and /admin, and where everyone else goes.
test.describe('signed out', () => {
  test.use({ staffUser: null });

  test('AC1: /staff sends you to sign-in and back after signing in', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin?tab=queues');
    await expect(staff).toHaveURL(/\/auth\/sign-in\?next=/);

    await staff.getByLabel('Email').fill(demoUsers.owner.email);
    await staff.getByLabel('Password').fill(DEMO_PASSWORD);
    await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(staff).toHaveURL(/\/admin\?tab=queues$/);
    expect(await workingLocation(staff)).toContain('Demo Barber Main Street');
  });

  test('AC2: an account with no organization goes to onboarding', async ({ devices }) => {
    const { staff } = devices;
    const email = await confirmedAccount();
    await staff.goto('/staff');
    await staff.getByLabel('Email').fill(email);
    await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
    await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(staff).toHaveURL(/\/onboarding$/);
    await expect(staff.getByRole('heading', { name: 'Set up your business' })).toBeVisible();

    await staff.goto('/admin');
    await expect(staff).toHaveURL(/\/onboarding$/);
  });
});

test('a member opening onboarding goes to the staff console', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/onboarding');
  await expect(staff).toHaveURL(/\/staff$/);
  await expect(staff.getByRole('heading', { name: 'Staff console' })).toBeVisible();
});

test('staff see only their own organization’s location', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/staff');
  expect(await workingLocation(staff)).toContain('Demo Barber Main Street');
  await expect(staff.getByText('Other Salon Berlin')).toHaveCount(0);
});
