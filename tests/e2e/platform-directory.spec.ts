import { demo, demoUsers, DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { signInTo } from './support/accounts.ts';
import { newOperator, signedInOperator } from './support/totp.ts';

// PLT10 (#416): the operator console's shell, tenant directory and org detail.
test.use({ staffUser: null });

test('AC1: an owner who is not an operator gets the 404 page', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/auth/sign-in?next=/platform');
  await staff.getByLabel('Email').fill(demoUsers.owner.email);
  await staff.getByLabel('Password').fill(DEMO_PASSWORD);
  await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(staff.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await staff.goto(`/platform/orgs/${demo.orgId}`);
  await expect(staff.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('AC2: an aal1 operator is sent to two-step sign-in before any console data loads', async ({
  devices,
}) => {
  const { staff } = devices;
  const consoleReads: string[] = [];
  staff.on('request', (request) => {
    if (/rpc\/platform_(list_orgs|get_org)/.test(request.url())) consoleReads.push(request.url());
  });
  const email = await newOperator();
  await signInTo(staff, email, '/platform/mfa');
  // Let sign-in finish landing before navigating again (WebKit interrupts the next load otherwise).
  await expect(staff.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await staff.goto(`/platform/orgs/${demo.orgId}`);
  await expect(staff).toHaveURL(/\/platform\/mfa\?next=/);
  await expect(staff.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  expect(consoleReads).toEqual([]);
});

test('an operator finds a tenant and opens it in two clicks (AC4: axe on both pages)', async ({
  devices,
}) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.goto('/platform');
  await expect(staff.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await staff.getByLabel('Search').fill('demo-barber');
  await staff.getByRole('button', { name: 'Search' }).click();
  await expect(staff).toHaveURL(/q=demo-barber/);
  const row = staff.getByTestId('tenant').filter({ hasText: 'Demo Barber' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(demoUsers.owner.email);
  await expect(row.getByText('Active')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  await row.getByRole('link', { name: 'Demo Barber' }).click();
  await expect(staff.getByRole('heading', { name: /Demo Barber/, level: 1 })).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(staff.getByRole('cell', { name: demoUsers.staff.email })).toBeVisible();
  await expect(staff.getByText('/q/demo-barber').first()).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Support access' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});

test('the status filter narrows the directory', async ({ devices }) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.goto('/platform?status=suspended&q=demo-barber');
  await expect(staff.getByText('No tenants match.')).toBeVisible();
  await staff.goto('/platform?status=active&q=demo-barber');
  await expect(staff.getByTestId('tenant')).toHaveCount(1);
});

test('#581: a malformed page cursor opens the first page instead of hanging', async ({
  devices,
}) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.goto('/platform?after=not-a-uuid&before=x,y');
  await expect(staff.getByTestId('tenant').first()).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Previous page' })).toHaveCount(0);
});
