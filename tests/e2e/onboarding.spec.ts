import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD, readAs } from './support/accounts.ts';

// A3 (#43): a new owner goes from an empty account to a business with a working queue.
test.use({ staffUser: null });

test('AC1: the wizard creates the org, location, owner membership and a default queue @core', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  const business = `Test Cafe ${Date.now()}`;

  await staff.goto('/auth/sign-in');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff).toHaveURL(/\/onboarding$/);
  await expectNoSeriousA11yViolations(staff);

  await staff.getByLabel('Business name').fill(business);
  await staff.getByRole('button', { name: 'Next' }).click();
  await staff.getByLabel('Location name').fill('Main Street');
  await staff.getByLabel('Street address').fill('1 Main Street');
  // Defaults to the device's zone; the test pins one so it doesn't depend on the runner.
  await staff.getByLabel('Time zone').fill('Europe/Berlin');
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: 'Next' }).click();
  await expect(staff.getByLabel('Queue name')).toHaveValue('Walk-ins');
  await expect(staff.getByLabel('Usual minutes per customer')).toHaveValue('10');
  await staff.getByRole('button', { name: 'Create my business' }).click();

  // The wizard ends on "Your line is live" with the join link, not on the dashboard.
  await expect(
    staff.getByRole('heading', { name: 'Main Street is ready for its first guest.' }),
  ).toBeFocused();
  await expect(staff.getByText('Your line is live')).toBeVisible();
  await expect(staff.getByTestId('join-url')).toContainText('/q/');
  await expect(staff.getByRole('img', { name: /^QR code for / })).toBeVisible();
  await expect(
    staff.getByText('Scan this with your phone, join, then call yourself'),
  ).toBeVisible();
  await expect(staff.getByText('accepts guests at any time of day')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('link', { name: 'Go to the dashboard' }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  await expect(staff.getByTestId('current-location')).toHaveText(`Main Street · ${business}`);

  const rows = await readAs(email, [
    'memberships?select=role,organizations(name)',
    'locations?select=name,address,tz',
    'queues?select=name',
    'services?select=name,expected_minutes',
  ]);
  expect(rows).toEqual([
    [{ role: 'owner', organizations: { name: business } }],
    [{ name: 'Main Street', address: '1 Main Street', tz: 'Europe/Berlin' }],
    [{ name: 'Walk-ins' }],
    [{ name: 'General', expected_minutes: 10 }],
  ]);
});

test('a time zone that is not on the list is refused before anything is created', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = await confirmedAccount();
  await staff.goto('/auth/sign-in?next=%2Fonboarding');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();

  await staff.getByLabel('Business name').fill('Nowhere Ltd');
  await staff.getByRole('button', { name: 'Next' }).click();
  await staff.getByLabel('Location name').fill('Somewhere');
  await staff.getByLabel('Time zone').fill('Mars/Olympus');
  await staff.getByRole('button', { name: 'Next' }).click();
  await expect(staff.getByText('Pick a time zone from the list.')).toBeVisible();
  await expect(staff.getByLabel('Queue name')).toHaveCount(0);
});
