import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { eventually, expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { uniqueEmail } from './support/mail.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// G2 (#52): a guest joins from the poster link on a phone and lands on their status page.
test('a double tap on Join creates exactly one visit @core', async ({ devices }) => {
  const { guest } = devices;
  const tickets: string[] = [];
  guest.on('response', async (response) => {
    if (!response.url().endsWith('/rpc/join_queue') || !response.ok()) return;
    tickets.push(((await response.json()) as { display_ticket: string }).display_ticket);
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest.getByRole('heading', { name: 'Join the queue' })).toBeVisible();
  await guest.getByLabel('Queue').selectOption(demo.queues.walkIns);
  await guest.getByLabel('What do you need?').selectOption(demo.services.beardTrim);
  await guest.getByLabel('First name').fill('Dana');
  const phone = guest.getByLabel('Mobile number (optional)');
  await expect(guest.getByLabel('Country code')).toBeVisible(); // lazy chunk loaded
  await expect(phone).toBeInViewport({ ratio: 1 });
  // The server dedupes a phone per queue, so each device project needs its own number.
  const pick = 200 + Math.floor(Math.random() * 800);
  const exchange = pick % 100 === 11 ? pick + 1 : pick; // N11 exchanges (411, 911) aren't numbers
  const line = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  await phone.fill(`+1 415 ${exchange} ${line}`);
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Join the queue' }).dblclick();

  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  expect(tickets.length).toBeGreaterThanOrEqual(1);
  expect(new Set(tickets).size).toBe(1);
});

// #503: Safari drew native selects about 23px tall; ours draw their own chevron and keep 48px.
test('every select on the join page is at least 48px tall', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest.getByLabel('Country code')).toBeVisible(); // lazy chunk loaded
  const selects = guest.locator('main select');
  expect(await selects.count()).toBeGreaterThanOrEqual(2);
  for (const select of await selects.all()) {
    const box = await select.boundingBox();
    expect(
      box?.height,
      (await select.getAttribute('aria-label')) ?? (await select.evaluate((el) => el.id)),
    ).toBeGreaterThanOrEqual(48);
    expect(await select.evaluate((el) => getComputedStyle(el).appearance)).toBe('none');
  }
});

test('the join page explains a missing name and an unknown link @core', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByText('Enter your first name so staff can call you.')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);

  await guest.goto('/q/no-such-place');
  await expect(guest.getByText("We can't find this queue")).toBeVisible();
});

test('a lost join response still takes the guest to their visit on retry', async ({ devices }) => {
  const { guest } = devices;
  let dropped = false;
  // The first join reaches the database, but its answer never reaches the phone.
  await guest.route('**/rest/v1/rpc/join_queue', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('connectionreset');
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(demo.queues.kids);
  await guest.getByLabel('First name').fill('Lost');
  const join = guest.getByRole('button', { name: 'Join the queue' });
  await join.click();
  await expect(
    guest.getByText("Couldn't join. Check your connection and try again."),
  ).toBeVisible();

  // #474: the replay returns the visit's link too, not just its ticket.
  await join.click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expect(guest.getByText(/K\d{3}/).first()).toBeVisible();
  expect(
    await guest.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('qm:join-key:')),
    ),
  ).toEqual([]);
});

/** Calls an api.* function over REST, as anon or with `bearer`. */
async function rpc(fn: string, args: object, bearer?: string) {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${bearer ?? anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
      'accept-profile': 'api',
    },
    body: JSON.stringify(args),
  });
  expect(response.ok, `${fn}: ${await response.clone().text()}`).toBe(true);
  return (await response.json()) as unknown;
}

async function staffToken(): Promise<string> {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(testUsers.staff),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

/**
 * Resolves once realtime accepts a channel join on `page`. The join page has no live indicator,
 * and right after global setup's db reset the realtime server can take seconds to accept sockets.
 */
function joinedChannel(page: Page, topic: string): Promise<void> {
  return new Promise((resolve) => {
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/realtime/v1/')) return;
      ws.on('framereceived', ({ payload }) => {
        const text = String(payload);
        if (text.includes(`"realtime:${topic}","phx_reply",{"status":"ok"`)) resolve();
      });
    });
  });
}

/** The public pulse topic of `queueId`, as the join page learns it. */
async function pulseTopic(queueId: string): Promise<string> {
  const location = (await rpc('get_location_public', { p_location_slug: demo.locationSlug })) as {
    queues: { id: string; pulse_id: string }[];
  };
  return `qpulse:${location.queues.find((q) => q.id === queueId)!.pulse_id}`;
}

// Browser-test run 4: only /v was live; the join page kept stale counts and missed a pause.
test('the join page shows a new waiting count and a pause within 3 s', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const subscribed = joinedChannel(guest, await pulseTopic(queue.id));
  await guest.goto(`/q/${demo.locationSlug}`);
  const option = guest.getByRole('option', { name: `${queue.name} (0 waiting)` });
  await expect(option).toBeAttached();
  await guest.getByLabel('Queue').selectOption(queue.id);
  // Subscribed before the change, and the poll is 30 s, so an update within 3 s is the pulse.
  await subscribed;

  await rpc('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Someone',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  await expect(guest.getByRole('option', { name: `${queue.name} (1 waiting)` })).toBeAttached({
    timeout: 3_000,
  });

  await rpc('set_queue_state', { p_queue_id: queue.id, p_state: 'paused' }, await staffToken());
  await expect(
    guest.getByText('This queue is paused. Please check back in a few minutes.'),
  ).toBeVisible({
    timeout: 3_000,
  });
});

test('an email given at join gets the visit its called message', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const email = uniqueEmail('join-email');

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Ana');
  await guest.getByLabel('Email (optional)').fill(email);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expectNoSeriousA11yViolations(guest);

  const called = (await rpc(
    'call_next',
    { p_queue_id: queue.id, p_counter_id: demo.counters.chair1, p_idempotency_key: randomUUID() },
    await staffToken(),
  )) as { id: string };
  const { url, serviceRoleKey } = supabaseEnv();
  const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  await eventually(async () => {
    const { data } = await service
      .schema('app')
      .from('notifications')
      .select('channel, template_key')
      .eq('visit_id', called.id);
    return data?.filter((n) => n.channel === 'email').map((n) => n.template_key);
  }).toContain('called');
});

test('an incomplete phone number blocks Join until it is fixed or cleared', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const joins: string[] = [];
  guest.on('request', (request) => {
    if (request.url().endsWith('/rpc/join_queue')) joins.push(request.postData() ?? '');
  });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Short number');
  const phone = guest.getByLabel('Mobile number (optional)');
  await expect(guest.getByLabel('Country code')).toBeVisible(); // lazy chunk loaded
  await phone.fill('123');
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  await expect(guest.getByText("That isn't a full mobile number.", { exact: false })).toBeVisible();
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await expectNoSeriousA11yViolations(guest);
  expect(joins).toEqual([]);

  await phone.fill('');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  expect(joins).toHaveLength(1);
  expect(JSON.parse(joins[0]!)).toMatchObject({ p_phone_e164: null });
});
