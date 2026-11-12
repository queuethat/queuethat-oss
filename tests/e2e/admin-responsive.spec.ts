import { readFileSync } from 'node:fs';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// ORG-15 (#94): every /admin route works at 375, 768 and 1280 px with no sideways scroll.

/**
 * The admin routes, read from the router's generated manifest, so a route added later is covered
 * without touching this spec. A dynamic segment gets a demo id.
 */
function adminRoutes(): string[] {
  const manifest = readFileSync(
    new URL('../../apps/web/src/routeTree.gen.ts', import.meta.url),
    'utf8',
  );
  const block = manifest.slice(
    manifest.indexOf('export interface FileRoutesByFullPath'),
    manifest.indexOf('export interface FileRoutesByTo'),
  );
  const paths = [...block.matchAll(/^\s+'(\/admin[^']*)':/gm)].map((m) => m[1]!);
  const routes = paths
    .map((p) => p.replace(/\/$/, '') || '/admin')
    .map((p) => p.replace('$queueId', demo.queues.walkIns));
  return [...new Set(routes)].filter((p) => !p.includes('$'));
}

const WIDTHS = [375, 768, 1280];

test.use({ staffUser: 'owner' });

test('the manifest lists the admin routes', () => {
  expect(adminRoutes()).toEqual(
    expect.arrayContaining(['/admin', '/admin/queues', '/admin/location/hours']),
  );
});

for (const route of adminRoutes()) {
  test(`AC1: ${route} fits at every width`, async ({ devices }) => {
    const { staff } = devices;
    for (const width of WIDTHS) {
      // Re-navigating straight from a live admin page to the same URL cancels its in-flight loads;
      // under parallel load that sometimes crashes WebKit's network process (libsoup), which blanks
      // the page or fails goto with "WebKit encountered an internal error". Settle on a blank page first.
      await staff.goto('about:blank');
      await staff.setViewportSize({ width, height: 900 });
      await staff.goto(route);
      await expect(staff.getByRole('main')).toBeVisible();
      await staff.waitForLoadState('networkidle');
      const overflow = await staff.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll, `${route} at ${width}px`).toBeLessThanOrEqual(overflow.width);
      await expectNoSeriousA11yViolations(staff);
    }
  });
}

test('a sidebar at 1280px, a drawer behind Menu at 375px', async ({ devices }) => {
  const { staff } = devices;
  const setUp = staff.getByRole('button', { name: 'Set up' });
  await staff.setViewportSize({ width: 1280, height: 900 });
  await staff.goto('/admin');
  await expect(setUp).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Menu' })).toBeHidden();
  await setUp.click();
  await expect(staff.getByRole('link', { name: 'Opening hours' })).toBeVisible();

  await staff.setViewportSize({ width: 375, height: 800 });
  await expect(staff.getByRole('link', { name: 'Opening hours' })).toBeHidden();
  await staff.getByRole('button', { name: 'Menu' }).click();
  if ((await setUp.getAttribute('aria-expanded')) === 'false') await setUp.click();
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('link', { name: 'Opening hours' }).click();
  await expect(staff).toHaveURL(/\/admin\/location\/hours$/);
  await expect(staff.getByRole('link', { name: 'Opening hours' })).toBeHidden();
});
