import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { signedInOperator } from './support/totp.ts';

// The operator console's navigation: three labelled groups, every page one click away, one current.
test.use({ staffUser: null });

const GROUPS = {
  Customers: ['Tenants', 'Activation', 'Messages'],
  Operations: ['Health', 'Usage', 'Blocks', 'Announcements'],
  Oversight: ['Audit log', 'Team', 'Two-step sign-in'],
};

test('an operator sees every page in three groups with the current one marked', async ({
  devices,
}) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.setViewportSize({ width: 1280, height: 900 });
  await staff.goto('/platform');
  const nav = staff.getByRole('navigation', { name: 'Platform console' });
  for (const [group, pages] of Object.entries(GROUPS)) {
    const list = nav.getByRole('list', { name: group });
    for (const page of pages) {
      await expect(list.getByRole('link', { name: page })).toBeVisible();
    }
  }
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
  const box = await nav.getByRole('link', { name: 'Tenants' }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(48);
  await expectNoSeriousA11yViolations(staff);
});

test('opening a page moves the mark, and a tenant page stays under Tenants', async ({
  devices,
}) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.setViewportSize({ width: 1280, height: 900 });
  await staff.goto('/platform');
  const nav = staff.getByRole('navigation', { name: 'Platform console' });
  await nav.getByRole('link', { name: 'Health' }).click();
  await expect(staff).toHaveURL(/\/platform\/health$/);
  await expect(nav.getByRole('link', { name: 'Health' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);

  await staff.goto(`/platform/orgs/${demo.orgId}`);
  await expect(nav.getByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
});

test('a phone keeps every link reachable without widening the page', async ({ devices }) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.setViewportSize({ width: 375, height: 812 });
  await staff.goto('/platform');
  const nav = staff.getByRole('navigation', { name: 'Platform console' });
  await expect(nav.getByRole('link', { name: 'Two-step sign-in' })).toBeVisible();
  const overflow = await staff.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
