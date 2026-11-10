import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// The nine analytics pages read as one place: a shared tab bar and a second row for reports.

test.describe('owner', () => {
  test.use({ staffUser: 'owner' });

  test('tabs move between insights pages', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/analytics');
    const tabs = staff.getByRole('navigation', { name: 'Insights' });
    for (const name of ['Analytics', 'Busy hours', 'Performance', 'ETA accuracy', 'Feedback']) {
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    }
    await expect(tabs.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoSeriousA11yViolations(staff);

    await tabs.getByRole('link', { name: 'Busy hours' }).click();
    await expect(staff).toHaveURL(/\/admin\/heatmap$/);
    await expect(staff.getByRole('heading', { name: 'Busy hours', level: 1 })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Busy hours' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoSeriousA11yViolations(staff);
  });

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

  test('the tab row scrolls sideways on a phone instead of widening the page', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 375, height: 812 });
    await staff.goto('/admin/performance');
    const tabs = staff.getByRole('navigation', { name: 'Insights' });
    await expect(tabs.getByRole('link', { name: 'Performance' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const overflow = await staff.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
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
