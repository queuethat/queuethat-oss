import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';

// 2B-J7 (#245): the join form on another site, and the headers that allow it only there.

const previewUrl = process.env.E2E_PREVIEW_URL!;

// The host is a real server on another loopback port: Chrome's local-network rules block a
// public host (and a fulfilled route) from reaching localhost, and a different port is still a
// different origin.
test('AC1: widget.js on a third-party page embeds the form; joining leaves the host page alone', async ({
  devices,
  baseURL,
}) => {
  const { guest } = devices;
  const host = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Host</title><h1>Our salon</h1>
      <script src="${baseURL}/widget.js" data-location="${demo.locationSlug}" async></script>`);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/`;
  try {
    await guest.goto(hostUrl);
    const frame = guest.frameLocator('iframe[title="Join the queue"]');
    await frame.getByLabel('First name').fill('Embed Eli');
    await frame.getByRole('button', { name: 'Join the queue' }).click();

    // The frame is not navigated; it offers the status page in a new tab instead.
    const link = frame.getByRole('link', { name: 'Open my place in line' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', /^\/v\/[\w-]+$/);
    expect(guest.url()).toBe(hostUrl);

    // The iframe grew to fit its content (height reported by postMessage, nothing else).
    const height = await guest
      .locator('iframe')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(120);

    const popup = guest.waitForEvent('popup');
    await link.click();
    await expect((await popup).url()).toMatch(/\/v\/[\w-]+$/);
  } finally {
    host.close();
  }
});

test('the widget page has no serious accessibility violations', async ({ devices }) => {
  await devices.guest.goto(`/w/${demo.locationSlug}`);
  await expect(devices.guest.getByLabel('First name')).toBeVisible();
  await expectNoSeriousA11yViolations(devices.guest);
});

test('AC2: only /w may be framed by other sites', async ({ request }) => {
  const widget = await request.get(`${previewUrl}/w/${demo.locationSlug}`);
  expect(widget.headers()['x-frame-options']).toBeUndefined();
  expect(widget.headers()['content-security-policy']).toContain('frame-ancestors *');
  for (const path of [`/q/${demo.locationSlug}`, '/v/some-token', '/staff', '/admin']) {
    const response = await request.get(`${previewUrl}${path}`);
    expect(response.headers()['x-frame-options'], path).toBe('DENY');
    expect(response.headers()['content-security-policy'], path).toContain("frame-ancestors 'none'");
  }
});

test('AC3: the admin page shows the embed code for this location', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/admin/widget');
  await expect(page.getByTestId('widget-snippet')).toContainText(
    `data-location="${demo.locationSlug}"`,
  );
  await expect(page.getByTestId('widget-snippet')).toContainText('/widget.js');
  await expect(
    page.frameLocator('iframe[title="Preview of the join widget"]').getByLabel('First name'),
  ).toBeVisible();
});
