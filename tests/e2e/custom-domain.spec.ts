import { demo } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// 3-DOM2 (#371): host-based routing. The setup page is in ee/tests/e2e (QueueThat Commercial License).
// The custom host is a hosts override: Playwright answers http://<host>/ from the dev server, and
// domain-check (not served by CI's Supabase) is stubbed. The database side is in pgTAP.

test.describe('on a custom host', () => {
  const HOST = 'book.e2e-domain.test';

  test.beforeEach(async ({ devices }, testInfo) => {
    const base = testInfo.project.use.baseURL!;
    const { guest } = devices;
    await guest.route(`http://${HOST}/**`, async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(`http://${HOST}`, base),
      });
      await route.fulfill({ response });
    });
    // Chrome refuses a public-looking host calling loopback (local network access), so the API
    // calls go through Playwright, with the CORS headers a real Supabase answers with.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    };
    await guest.route(`${supabaseEnv().url}/**`, async (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: cors });
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    // config.js sets window.__APP_CONFIG__ before the bundle loads; give it the main host.
    await guest.route(`http://${HOST}/config.js`, (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `window.__APP_CONFIG__ = { PUBLIC_URL: ${JSON.stringify(base)} };`,
      }),
    );
    await guest.route('**/functions/v1/domain-check?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ location_slug: demo.locationSlug }),
      }),
    );
  });

  // The handlers above proxy requests the page may still have in flight when the test's last
  // assertion passes; without this, a late route.fulfill fails ("Fetch response has been disposed")
  // as the context closes.
  test.afterEach(async ({ devices }) => {
    await devices.guest.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test("AC1: / opens the join page of the host's location", async ({ devices }) => {
    const { guest } = devices;
    await guest.goto(`http://${HOST}/`);
    await expect(guest).toHaveURL(`http://${HOST}/q/${demo.locationSlug}`);
    await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('AC2: /staff goes to the main host', async ({ devices }, testInfo) => {
    const { guest } = devices;
    const base = testInfo.project.use.baseURL!;
    await guest.route(`${base}/**`, (route) => route.continue());
    await guest.goto(`http://${HOST}/staff`);
    await expect(guest).toHaveURL(
      new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(staff|auth)`),
    );
  });

  test('AC4 (#1438): /admin goes to the main host too', async ({ devices }, testInfo) => {
    const { guest } = devices;
    const base = testInfo.project.use.baseURL!;
    await guest.route(`${base}/**`, (route) => route.continue());
    await guest.goto(`http://${HOST}/admin/poster?x=1`);
    await expect(guest).toHaveURL(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  });

  test('AC5 (#1438): a guest joins from the custom host, and the host holds no staff session', async ({
    devices,
  }) => {
    const { guest } = devices;
    const queue = await freshQueue();
    await guest.goto(`http://${HOST}/q/${demo.locationSlug}`);
    await guest.getByLabel('Queue').selectOption(queue.id);
    await guest.getByLabel('First name').fill('Dora');
    await guest.getByRole('button', { name: 'Join the queue' }).click();
    await expect(guest).toHaveURL(new RegExp(`^http://${HOST.replace(/\./g, '\\.')}/v/[\\w-]+$`));
    await expect(guest.getByTestId('ticket')).toBeVisible();
    // Storage is per origin: whatever the browser holds for the main host is not here, and the guest
    // page itself stores no sign-in (guests never sign in, I-7).
    const authKeys = await guest.evaluate(() =>
      Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)),
    );
    expect(authKeys).toEqual([]);
  });
});
