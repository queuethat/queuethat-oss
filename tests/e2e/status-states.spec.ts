import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// DS-20 (#1024): the status page leads with the ticket and position, takes over when called, and has
// designed missed, ended and offline states. What each state says still comes from the database.
const { url, anonKey } = supabaseEnv();

async function rpc<T>(fn: string, args: object, bearer = anonKey): Promise<T> {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'content-profile': 'api',
      'accept-profile': 'api',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${fn}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function staffToken(): Promise<string> {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(testUsers.staff),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

async function joinFresh(name: string) {
  const queue = await freshQueue();
  const joined = await rpc<{ token: string }>('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: randomUUID().replaceAll('-', ''),
  });
  return { queue, token: joined.token };
}

async function callNext(queueId: string) {
  return rpc<{ id: string; version: number }>(
    'call_next',
    { p_queue_id: queueId, p_counter_id: demo.counters.chair1, p_idempotency_key: randomUUID() },
    await staffToken(),
  );
}

test('waiting: the ticket, a Waiting pill and the position sit together', async ({ devices }) => {
  const { guest } = devices;
  const { token } = await joinFresh('Wait');
  await guest.goto(`/v/${token}`);
  const hero = guest.getByRole('tabpanel');
  await expect(hero.getByTestId('ticket')).toBeVisible();
  await expect(hero.getByText('Waiting', { exact: true })).toBeVisible();
  await expect(hero.getByTestId('position')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
});

test('called: the takeover has the called edge, a Called label and the counter', async ({
  devices,
}) => {
  const { guest } = devices;
  const { queue, token } = await joinFresh('Called');
  await guest.goto(`/v/${token}`);
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await callNext(queue.id);
  const takeover = guest.getByTestId('called-takeover');
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  await expect(takeover.getByText('Called', { exact: true })).toBeVisible();
  await expect(takeover).toContainText('Go to Chair 1');
  await expect(takeover).toHaveCSS('border-top-width', '8px');
  await expectNoSeriousA11yViolations(guest);
});

test('called: reduced motion drops the fade', async ({ devices }) => {
  const { guest } = devices;
  await guest.emulateMedia({ reducedMotion: 'reduce' });
  const { queue, token } = await joinFresh('Calm');
  await guest.goto(`/v/${token}`);
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await callNext(queue.id);
  const takeover = guest.getByTestId('called-takeover');
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  await expect(takeover).toHaveCSS('animation-name', 'none');
});

for (const [action, pill, sentence] of [
  ['no_show', 'Missed', "We called you but couldn't find you. Ask staff if you're still here."],
  ['done', 'Done', ''],
] as const) {
  test(`${action}: the ended state has its pill and no live indicator`, async ({ devices }) => {
    const { guest } = devices;
    const { queue, token } = await joinFresh('Ended');
    const called = await callNext(queue.id);
    const staff = await staffToken();
    if (action === 'done') {
      const serving = await rpc<{ version: number }>(
        'transition_visit',
        {
          p_visit_id: called.id,
          p_action: 'start',
          p_expected_version: called.version,
          p_idempotency_key: randomUUID(),
        },
        staff,
      );
      await rpc(
        'transition_visit',
        {
          p_visit_id: called.id,
          p_action: 'complete',
          p_expected_version: serving.version,
          p_idempotency_key: randomUUID(),
        },
        staff,
      );
    } else {
      await rpc(
        'transition_visit',
        {
          p_visit_id: called.id,
          p_action: 'no_show',
          p_expected_version: called.version,
          p_idempotency_key: randomUUID(),
        },
        staff,
      );
    }
    await guest.goto(`/v/${token}`);
    await expect(guest.getByRole('tabpanel').getByText(pill, { exact: true })).toBeVisible();
    if (sentence) await expect(guest.getByText(sentence)).toBeVisible();
    await expect(guest.locator('[data-state="live"]')).toHaveCount(0);
    await expectNoSeriousA11yViolations(guest);
  });
}

test('offline: a card says the position is the last one known', async ({ devices }) => {
  const { guest } = devices;
  const { token } = await joinFresh('Offline');
  await guest.goto(`/v/${token}`);
  await expect(guest.getByTestId('position')).toBeVisible();
  await guest.context().setOffline(true);
  const card = guest.getByTestId('offline');
  await expect(card).toContainText("You're offline");
  await expect(guest.getByTestId('position')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.context().setOffline(false);
  await expect(card).toHaveCount(0);
});
