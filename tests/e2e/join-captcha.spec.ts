import type { Page, Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { supabaseDeps } from '../../supabase/functions/join-pass/deps.ts';
import {
  createJoinPassHandler,
  turnstileVerifier,
} from '../../supabase/functions/join-pass/handler.ts';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// Turnstile on online joins. CI calls neither Cloudflare nor the edge runtime, so:
// - the widget script is a stand-in that issues Cloudflare's documented dummy token;
// - join-pass runs its own handler and Supabase wiring in Node, against the real database;
// - siteverify answers as Cloudflare's test secrets do (checked live: 1x… accepts any token,
//   2x… rejects every one; the passing one reports hostname example.com).
// The deployment-wide site key stays unset in the shared database, so other specs keep joining
// without a pass: the page is told one is set. join_pass.test.sql covers the database refusing
// online joins without a pass.

const SITE_KEY = '1x00000000000000000000AA';
const PASSING_SECRET = '1x0000000000000000000000000000000AA';
const FAILING_SECRET = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const testKeySiteverify = (async (_url: string | URL | Request, init?: RequestInit) => {
  const { secret, response } = JSON.parse(String(init?.body)) as {
    secret: string;
    response: string;
  };
  // Test keys always report example.com, whatever page the widget ran on.
  const success = secret.startsWith('1x') && response.length > 0;
  return Response.json({ success, hostname: 'example.com' });
}) as typeof fetch;

const FAKE_WIDGET = `window.turnstile = {
  render(el, o) {
    el.textContent = 'Success!';
    setTimeout(() => o.callback(${JSON.stringify(DUMMY_TOKEN)}), 50);
    return 'w1';
  },
  remove() {},
};`;

// A handler that finishes after the page left (or the test ended) finds its route disposed;
// that is the guest going away, not a failure.
async function guarded(page: Page, route: Route, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    if (!page.isClosed() && !/disposed|closed|has been/i.test(String(error))) throw error;
  }
}

async function withTurnstile(page: Page, secret: string) {
  const env = supabaseEnv();
  const joinPass = createJoinPassHandler({
    ...supabaseDeps(createClient, env),
    verify: turnstileVerifier(secret, testKeySiteverify),
  });
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_WIDGET }),
  );
  await page.route('**/rest/v1/rpc/get_location_public', (route: Route) =>
    guarded(page, route, async () => {
      const response = await route.fetch();
      const location = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...location, captcha_site_key: SITE_KEY } });
    }),
  );
  await page.route('**/functions/v1/join-pass', (route: Route) =>
    guarded(page, route, async () => {
      const request = route.request();
      const answer = await joinPass(
        new Request(request.url(), {
          method: request.method(),
          headers: request.headers(),
          body: request.method() === 'POST' ? request.postData() : undefined,
        }),
      );
      await route.fulfill({
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
        body: await answer.text(),
      });
    }),
  );
}

test('with Turnstile on, a guest passes the check and joins with a pass', async ({ devices }) => {
  const { guest } = devices;
  await withTurnstile(guest, PASSING_SECRET);
  const queue = await freshQueue();
  const joinBody = guest.waitForRequest('**/rest/v1/rpc/join_queue');

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Robin');
  await expect(guest.getByRole('group', { name: "Checking you're not a robot" })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeEnabled();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const pass = ((await joinBody).postDataJSON() as { p_join_pass: string | null }).p_join_pass;
  expect(pass).toMatch(/^[\w-]{43}$/);
});

test('when Cloudflare rejects the token, the guest gets no pass and is told why', async ({
  devices,
}) => {
  const { guest } = devices;
  await withTurnstile(guest, FAILING_SECRET);
  const queue = await freshQueue();
  let joins = 0;
  guest.on('request', (request) => {
    if (request.url().endsWith('/rpc/join_queue')) joins++;
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Robin');
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  await expect(guest.getByRole('alert')).toHaveText(
    "We couldn't confirm you're not a robot. Wait for the check above to finish, then try again, or ask staff to add you.",
  );
  await expect(guest).toHaveURL(new RegExp(`/q/${demo.locationSlug}$`));
  expect(joins).toBe(0);
});

// #576: a guest whose Turnstile widget can't produce a token is told what to do, not left with
// a disabled button.
interface Driven {
  __widget: { callback: (token: string) => void; 'error-callback': () => void };
}

const PROBLEM =
  "We couldn't run the check that keeps robots out. Reload the page, or ask staff to add you.";

test('when the widget script is blocked, the guest is told to reload or ask staff', async ({
  devices,
}) => {
  const { guest } = devices;
  await withTurnstile(guest, PASSING_SECRET);
  // Registered last, so it wins: an ad blocker or a venue network that drops Cloudflare.
  await guest.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.abort(),
  );
  const queue = await freshQueue();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Robin');

  await expect(guest.getByRole('alert').filter({ hasText: PROBLEM })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();
  await expect(guest.getByRole('button', { name: 'Reload the page' })).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
});

test('when the widget reports an error, the message shows at once and clears if it recovers', async ({
  devices,
}) => {
  const { guest } = devices;
  await withTurnstile(guest, PASSING_SECRET);
  await guest.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      // Cloudflare's always-fail key errors and retries; the test drives the widget by hand.
      body: `window.turnstile = {
        render(el, o) {
          window.__widget = o;
          return 'w1';
        },
        remove() {},
      };`,
    }),
  );
  const queue = await freshQueue();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.waitForFunction(() => 'turnstile' in window && '__widget' in window);
  await guest.evaluate(() => (window as unknown as Driven).__widget['error-callback']());
  await expect(guest.getByRole('alert').filter({ hasText: PROBLEM })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();

  await guest.evaluate(
    (token) => (window as unknown as Driven).__widget.callback(token),
    DUMMY_TOKEN,
  );
  await expect(guest.getByRole('alert').filter({ hasText: PROBLEM })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeEnabled();
});
