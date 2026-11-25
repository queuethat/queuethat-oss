// SPDX-License-Identifier: LicenseRef-QueueThat-EE

import { expect, expectNoSeriousA11yViolations, test } from '../../../tests/e2e/fixtures.ts';

// Reports (scheduled, custom, asked) are ee pages: each joins the Insights tab row, and the
// sidebar names them with real labels, never raw string keys.

test.describe('owner', () => {
  test.use({ staffUser: 'owner' });

  test('Insights offers scheduled, custom and asked reports as tabs', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/analytics');
    const tabs = staff.getByRole('navigation', { name: 'Insights' });
    for (const name of ['Scheduled reports', 'Custom reports', 'Ask analytics']) {
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    }
    await expect(staff.getByRole('navigation', { name: 'Admin' })).not.toContainText('nav.');
    await expect(tabs).not.toContainText('nav.');

    await tabs.getByRole('link', { name: 'Ask analytics' }).click();
    await expect(staff).toHaveURL(/\/admin\/x\/ask-analytics$/);
    await expect(tabs.getByRole('link', { name: 'Ask analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoSeriousA11yViolations(staff);

    // The address from before reports moved to ee/ still lands on the page.
    await staff.goto('/admin/reports/schedules');
    await expect(staff).toHaveURL(/\/admin\/x\/reports$/);
  });
});

test.describe('staff', () => {
  test.use({ staffUser: 'staff' });

  test('staff see the report pages they may open and no scheduled reports', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/analytics');
    const tabs = staff.getByRole('navigation', { name: 'Insights' });
    await expect(tabs.getByRole('link', { name: 'Compare locations' })).toHaveCount(0);
    await expect(tabs.getByRole('link', { name: 'Ask analytics' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Scheduled reports' })).toHaveCount(0);
    await tabs.getByRole('link', { name: 'Custom reports' }).click();
    await expect(staff).toHaveURL(/\/admin\/x\/reports-custom$/);
  });
});
