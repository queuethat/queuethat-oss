import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// Related account pages share one column and one tab bar: connections, developers, privacy.

test.describe('owner', () => {
  test.use({ staffUser: 'owner' });

  test('connections: integrations, WhatsApp, Google and the calendar feed are tabs', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/integrations');
    const tabs = staff.getByRole('navigation', { name: 'Connections' });
    for (const name of ['Integrations', 'WhatsApp', 'Google listing', 'Calendar feed']) {
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    }
    await expect(tabs.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoSeriousA11yViolations(staff);

    await tabs.getByRole('link', { name: 'WhatsApp' }).click();
    await expect(staff).toHaveURL(/\/admin\/whatsapp$/);
    await expect(tabs.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.getByRole('link', { name: 'Calendar feed' }).click();
    await expect(staff).toHaveURL(/\/admin\/account\/calendar$/);
    await expect(tabs.getByRole('link', { name: 'Calendar feed' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('developers: keys, webhooks, chat alerts and domains are tabs', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/developers/api-keys');
    const tabs = staff.getByRole('navigation', { name: 'Developers' });
    for (const name of ['API keys', 'Webhooks', 'Chat alerts', 'Custom domains']) {
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    }
    await expectNoSeriousA11yViolations(staff);
    await tabs.getByRole('link', { name: 'Custom domains' }).click();
    await expect(staff).toHaveURL(/\/admin\/domains$/);
    await expect(tabs.getByRole('link', { name: 'Custom domains' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('privacy: Data requests is current on its own page, not Privacy', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/privacy');
    const tabs = staff.getByRole('navigation', { name: 'Privacy and data' });
    await expect(tabs.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.getByRole('link', { name: 'Data requests' }).click();
    await expect(staff).toHaveURL(/\/admin\/privacy\/requests$/);
    await expect(tabs.getByRole('link', { name: 'Data requests' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(tabs.getByRole('link', { name: 'Privacy', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoSeriousA11yViolations(staff);
    await tabs.getByRole('link', { name: 'Export data' }).click();
    await expect(staff).toHaveURL(/\/admin\/export$/);
  });

  test('a phone gets a sideways-scrolling tab row, not a wider page', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 375, height: 812 });
    await staff.goto('/admin/developers/webhooks');
    await expect(
      staff.getByRole('navigation', { name: 'Developers' }).getByRole('link', { name: 'Webhooks' }),
    ).toHaveAttribute('aria-current', 'page');
    const overflow = await staff.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test('a single-tab section shows no bar', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/usage');
    await expect(staff.getByRole('main')).toBeVisible();
    await expect(staff.getByRole('navigation', { name: 'Plan and usage' })).toHaveCount(0);
  });
});

test.describe('staff', () => {
  test.use({ staffUser: 'staff' });

  test('privacy has one page for staff, so no bar', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/privacy');
    await expect(staff.getByRole('main')).toBeVisible();
    await expect(staff.getByRole('navigation', { name: 'Privacy and data' })).toHaveCount(0);
  });
});
