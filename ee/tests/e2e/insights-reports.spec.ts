// SPDX-License-Identifier: LicenseRef-QueueThat-EE

import { expect, expectNoSeriousA11yViolations, test } from '../../../tests/e2e/fixtures.ts';

// Reports (scheduled, custom, asked) are ee pages: their second tab row lives with them.

test.describe('owner', () => {
  test.use({ staffUser: 'owner' });

  test('Reports holds scheduled, custom and asked reports behind a second row', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/analytics');
    await staff
      .getByRole('navigation', { name: 'Insights' })
      .getByRole('link', { name: 'Reports' })
      .click();
    await expect(staff).toHaveURL(/\/admin\/reports\/schedules$/);
    const reports = staff.getByRole('navigation', { name: 'Reports', exact: true });
    for (const name of ['Scheduled reports', 'Custom reports', 'Ask analytics']) {
      await expect(reports.getByRole('link', { name })).toBeVisible();
    }
    await reports.getByRole('link', { name: 'Ask analytics' }).click();
    await expect(staff).toHaveURL(/\/admin\/reports\/ask$/);
    await expect(reports.getByRole('link', { name: 'Ask analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      staff.getByRole('navigation', { name: 'Insights' }).getByRole('link', { name: 'Reports' }),
    ).toHaveAttribute('aria-current', 'page');
    await expectNoSeriousA11yViolations(staff);
  });
});

test.describe('staff', () => {
  test.use({ staffUser: 'staff' });

  test('staff see the pages they may open and no scheduled reports', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/analytics');
    const tabs = staff.getByRole('navigation', { name: 'Insights' });
    await expect(tabs.getByRole('link', { name: 'Compare locations' })).toHaveCount(0);
    await tabs.getByRole('link', { name: 'Reports' }).click();
    await expect(staff).toHaveURL(/\/admin\/reports\/custom$/);
    const reports = staff.getByRole('navigation', { name: 'Reports', exact: true });
    await expect(reports.getByRole('link', { name: 'Scheduled reports' })).toHaveCount(0);
    await expect(reports.getByRole('link', { name: 'Ask analytics' })).toBeVisible();
  });
});
