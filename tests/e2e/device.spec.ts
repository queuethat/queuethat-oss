import type { Page } from '@playwright/test';
import { IDLE_MS, POLL_MS } from '../../apps/web/src/features/device/version.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { asOwner, newCode, pair, servePairDevice } from './support/pairing.ts';

// D3 (#50): /display and /kiosk pair with a code, keep their session, notice revocation and
// reload themselves for a new deploy. Pairing runs the real pair-device handler in Node
// (support/pairing.ts).

/**
 * Counts the requests a page makes to `pattern`. The screen's polls are react-query intervals that
 * start when the screen mounts and fetches once, so seeing that first request is how a test knows
 * the timer exists before it moves the fake clock. Rendered text alone can come first.
 */
function countRequests(page: Page, pattern: RegExp) {
  // `sinceNavigation` restarts when the page reloads, so a test can wait for the new page's poll.
  const counter = { count: 0, sinceNavigation: 0 };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) counter.sinceNavigation = 0;
  });
  // Counted when the response is in, so the screen has its answer by the time a test reads it.
  page.on('requestfinished', (request) => {
    if (!pattern.test(request.url())) return;
    counter.count++;
    counter.sinceNavigation++;
  });
  return counter;
}

test('a TV pairs with a code and stays paired across reloads', async ({ devices }) => {
  const { display } = devices;
  await servePairDevice(display);
  await display.goto('/display');
  await expect(display.getByRole('heading', { name: 'Pair this screen' })).toBeVisible();
  await expectNoSeriousA11yViolations(display);

  await pair(display, '000000');
  await expect(display.getByText('That code is wrong, used or expired.')).toBeVisible();

  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();

  await display.reload();
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  await expect(display.getByRole('heading', { name: 'Pair this screen' })).toHaveCount(0);
});

test('a code for a kiosk does not pair a TV', async ({ devices }) => {
  const { display } = devices;
  await servePairDevice(display);
  await display.goto('/kiosk');
  await pair(display, await newCode('kiosk'));
  await expect(display.getByRole('heading', { name: 'Demo Barber Main Street' })).toBeVisible();

  // Same browser (and stored session), fresh tab: WebKit can fail navigating a page away while
  // its heartbeat or version poll is in flight, which is not what this test is about.
  const tv = await display.context().newPage();
  await tv.goto('/display');
  await expect(tv.getByRole('heading', { name: 'Pair this screen' })).toBeVisible();
});

test('#473: a paired TV that opens staff pages goes back to its screen', async ({ devices }) => {
  const { display } = devices;
  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();

  // A fresh tab per path in the same browser (and stored session): WebKit can fail navigating a
  // page away while its heartbeat or version poll is in flight, which is not what this tests.
  for (const path of ['/staff', '/admin/devices', '/onboarding']) {
    const tab = await display.context().newPage();
    await tab.goto(path);
    await expect(tab).toHaveURL(/\/display$/);
    await expect(tab.getByRole('heading', { name: 'Now serving' })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await tab.close();
  }
});

test('a revoked TV goes back to the pairing screen', async ({ devices }) => {
  const { display } = devices;
  await display.clock.install();
  await servePairDevice(display);
  const heartbeats = countRequests(display, /\/rpc\/device_heartbeat/);
  await display.goto('/display');
  const name = `E2E revoked display ${crypto.randomUUID()}`;
  await pair(display, await newCode('display', name));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  await expect.poll(() => heartbeats.count).toBeGreaterThan(0);

  const api = await asOwner();
  const { data: device } = await api
    .schema('app')
    .from('devices')
    .select('id')
    .eq('name', name)
    .single();
  const { error } = await api.rpc('revoke_device', { p_device_id: device!.id });
  expect(error).toBeNull();

  await display.clock.fastForward(POLL_MS + 1_000);
  await expect(display.getByRole('heading', { name: 'Pair this screen' })).toBeVisible();
});

test('AC1: an idle TV reloads within 5 minutes of a new deploy, once', async ({ devices }) => {
  const { display } = devices;
  await display.clock.install();
  await servePairDevice(display);
  // Until the "deploy", /version.json answers with whatever this build is.
  const deploy: { version?: string } = {};
  const versionChecks = countRequests(display, /\/version\.json/);
  await display.route('**/version.json*', (route) =>
    deploy.version
      ? route.fulfill({
          json: { version: deploy.version },
          headers: { 'cache-control': 'no-store' },
        })
      : route.continue(),
  );
  await display.goto('/display');
  await pair(display, await newCode('display'));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  await expect.poll(() => versionChecks.count).toBeGreaterThan(0);

  let loads = 0;
  display.on('load', () => loads++);
  deploy.version = 'next-deploy';
  await display.clock.fastForward(POLL_MS + IDLE_MS);
  await expect.poll(() => loads).toBe(1);
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();

  // The reloaded page still sees a version it doesn't run (this bundle never changes), so the
  // cooldown is what stops a loop. Wait for its poll to start, then let two polls happen.
  await expect.poll(() => versionChecks.sinceNavigation).toBeGreaterThan(0);
  const polled = versionChecks.count;
  await display.clock.fastForward(POLL_MS * 2);
  await expect.poll(() => versionChecks.count).toBeGreaterThan(polled);
  expect(loads).toBe(1);
});
