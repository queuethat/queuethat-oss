import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// Grouped admin navigation (Run open, the rest collapsed) and the Go to… palette.

test.describe('owner', () => {
  test.use({ staffUser: 'owner' });

  test('Run starts open, the other groups start collapsed and stay reachable', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin');
    const nav = staff.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('button', { name: 'Run' })).toHaveAttribute('aria-expanded', 'true');
    for (const daily of ['Today', 'Live queue', 'Appointments', 'Guests', 'Message activity']) {
      await expect(nav.getByRole('link', { name: daily })).toBeVisible();
    }
    for (const group of ['Team', 'Set up', 'Advanced', 'Insights', 'Account']) {
      await expect(nav.getByRole('button', { name: group })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    }
    await expect(nav.getByRole('link', { name: 'Busy hours' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(staff);

    // Keyboard toggle, and the choice survives a reload.
    const insights = nav.getByRole('button', { name: 'Insights' });
    await insights.focus();
    await staff.keyboard.press('Enter');
    await expect(insights).toHaveAttribute('aria-expanded', 'true');
    await staff.reload();
    await expect(nav.getByRole('button', { name: 'Insights' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await nav.getByRole('button', { name: 'Insights' }).click();
    await expect(nav.getByRole('link', { name: 'Webhooks' })).toHaveCount(0);

    // Two clicks: the group, then the page.
    await nav.getByRole('button', { name: 'Account' }).click();
    await nav.getByRole('link', { name: 'Developers' }).click();
    await expect(staff).toHaveURL(/\/admin\/developers\/api-keys$/);
    await expect(nav.getByRole('button', { name: 'Account' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(nav.getByRole('link', { name: 'Developers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: 'Danger zone' })).toBeVisible();
    await expectNoSeriousA11yViolations(staff);
  });

  test('visiting a page opens its group', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/heatmap');
    const nav = staff.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('button', { name: 'Insights' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(nav.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: 'Busy hours' })).toHaveCount(0);
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
    await staff.goto('/admin/queues');
    await expect(nav.getByRole('link', { name: 'Queue setup' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
  });

  test('Insights keeps two sidebar entries; the tab pages open from Go to…', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin');
    await expect(staff.getByRole('main')).toBeVisible();
    await staff.keyboard.press('Control+k');
    const dialog = staff.getByRole('dialog', { name: 'Go to' });
    await dialog.getByRole('combobox').fill('busy hours');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await staff.keyboard.press('Enter');
    await expect(staff).toHaveURL(/\/admin\/heatmap$/);

    const sidebar = staff.getByRole('navigation', { name: 'Admin' });
    await expect(sidebar.getByRole('button', { name: 'Insights' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(sidebar.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const folded of ['Busy hours', 'Performance', 'ETA accuracy', 'Feedback']) {
      await expect(sidebar.getByRole('link', { name: folded })).toHaveCount(0);
    }
  });

  test('Account keeps one entry per section; its tab pages mark that entry', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/developers/webhooks');
    const nav = staff.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('button', { name: 'Account' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(nav.getByRole('link', { name: 'Developers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const entry of ['Connections', 'Privacy and data', 'Help']) {
      await expect(nav.getByRole('link', { name: entry })).toBeVisible();
    }
    for (const folded of ['Webhooks', 'WhatsApp', 'Export data', 'Data requests']) {
      await expect(nav.getByRole('link', { name: folded })).toHaveCount(0);
    }
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);

    await staff.goto('/admin/privacy/requests');
    await expect(nav.getByRole('link', { name: 'Privacy and data' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await staff.goto('/admin/account/calendar');
    await expect(nav.getByRole('link', { name: 'Connections' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('on a phone the Today page starts within the first 300 px, under one account menu', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 390, height: 800 });
    await staff.goto('/admin');
    const main = staff.getByRole('main');
    await expect(main).toBeVisible();
    const top = await main.evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeLessThan(300);
    // The tablet buttons are not in the header; they live in the account menu.
    await expect(staff.getByRole('button', { name: 'Switch operator' })).toHaveCount(0);
    await staff.getByRole('button', { name: 'Account' }).click();
    for (const item of ['Switch operator', 'Set my PIN', 'Change password']) {
      await expect(staff.getByRole('menuitem', { name: item })).toBeVisible();
    }
  });

  test('routing and priority sit under Advanced and open from Go to…', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/routing');
    const nav = staff.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(nav.getByRole('link', { name: 'Routing' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('button', { name: 'Set up' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await staff.keyboard.press('Control+k');
    const dialog = staff.getByRole('dialog', { name: 'Go to' });
    await dialog.getByRole('combobox').fill('priority');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await staff.keyboard.press('Enter');
    await expect(staff).toHaveURL(/\/admin\/queues\/priority$/);
  });

  test('Ctrl+K opens Go to…, finds an advanced page and opens it', async ({ devices }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin');
    await expect(staff.getByRole('main')).toBeVisible();
    await staff.keyboard.press('Control+k');
    const dialog = staff.getByRole('dialog', { name: 'Go to' });
    await expect(dialog).toBeVisible();
    await expectNoSeriousA11yViolations(staff);
    await dialog.getByRole('combobox').fill('webhook');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await staff.keyboard.press('Enter');
    await expect(staff).toHaveURL(/\/admin\/developers\/webhooks$/);
    await expect(dialog).toBeHidden();
  });
});

test.describe('staff', () => {
  test.use({ staffUser: 'staff' });

  test('role filters hide owner and admin pages from the nav and the palette', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin');
    const nav = staff.getByRole('navigation', { name: 'Admin' });
    // Staff see the Team group only when a build adds a staff page to it (shifts, in ee); the AGPL
    // build has none, so open it if it is there.
    await expect(nav.getByRole('button', { name: 'Set up' })).toBeVisible();
    const team = nav.getByRole('button', { name: 'Team' });
    if ((await team.count()) > 0) await team.click();
    await nav.getByRole('button', { name: 'Set up' }).click();
    await nav.getByRole('button', { name: 'Advanced' }).click();
    await nav.getByRole('button', { name: 'Account' }).click();
    await expect(nav.getByRole('link', { name: 'Opening hours' })).toBeVisible();
    for (const hidden of [
      'Roles',
      'API keys',
      'Webhooks',
      'Custom domains',
      'Export data',
      'Data requests',
    ]) {
      await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
    }

    await staff.keyboard.press('Control+k');
    const dialog = staff.getByRole('dialog', { name: 'Go to' });
    await dialog.getByRole('combobox').fill('webhook');
    await expect(dialog.getByText('No page matches that.')).toBeVisible();
  });
});
