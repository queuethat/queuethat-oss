import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';

// 3-DOM2 (#371): the admin page, host-based routing and the poster address.
// The custom host is a hosts override: Playwright answers http://<host>/ from the dev server, and
// domain-check (not served by CI's Supabase) is stubbed. The database side is in pgTAP.

function serviceClient() {
  const { serviceRoleKey, url } = supabaseEnv();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema('app');
}

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC3: adds a domain, shows the DNS records, and the poster follows only once it is verified', async ({
    devices,
  }) => {
    const { staff } = devices;
    const host = `book-${crypto.randomUUID().slice(0, 8)}.example.org`;
    const db = serviceClient();
    try {
      await staff.goto('/admin/domains');
      await staff.getByRole('button', { name: 'Add domain' }).click();
      const form = staff.getByRole('dialog', { name: 'Add a custom domain' });
      await form.getByRole('textbox', { name: 'Domain' }).fill(host);
      await expectNoSeriousA11yViolations(staff);
      await form.getByRole('button', { name: 'Add domain' }).click();

      const row = staff.getByTestId('domain').filter({ hasText: host });
      await expect(row).toContainText('Waiting for DNS');
      await expect(row.getByLabel('TXT record name')).toHaveValue(`_queue-verify.${host}`);
      await expect(row.getByLabel('TXT record value')).toHaveValue(/^[0-9a-f]{32}$/);

      await staff.goto('/admin/poster');
      await expect(staff.getByTestId('poster')).toContainText(`/q/${demo.locationSlug}`);
      await expect(staff.getByTestId('poster')).not.toContainText(host);

      await db.from('custom_domains').update({ status: 'verified' }).eq('hostname', host);
      await staff.goto('/admin/poster');
      await expect(staff.getByTestId('poster')).toContainText(
        `https://${host}/q/${demo.locationSlug}`,
      );
    } finally {
      await db.from('custom_domains').delete().eq('hostname', host);
    }
  });
});

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
});
