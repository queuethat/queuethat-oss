import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// G6 (#56): a call takes over the screen with the counter, rings (once the guest has tapped to
// allow sound, as iOS requires) and vibrates; a recall does it all again. The tap stays on offer
// while called, so a guest who missed it before the call still hears the recall.

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

test('AC1: when called, the takeover shows the counter within 3 s, rings and vibrates; a recall repeats it', async ({
  devices,
}) => {
  const { guest } = devices;
  // Count what the page asks the device to do; headless browsers have no speaker or motor.
  await guest.addInitScript(() => {
    const w = window as unknown as { beeps: number; buzzes: number };
    w.beeps = 0;
    w.buzzes = 0;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      w.beeps++;
      return create.call(this);
    };
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        w.buzzes++;
        return true;
      },
    });
  });
  const counts = () =>
    guest.evaluate(() => {
      const w = window as unknown as { beeps: number; buzzes: number };
      return { beeps: w.beeps, buzzes: w.buzzes };
    });

  const queue = await freshQueue();
  const { token } = await rpc<{ token: string }>('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Cal',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: randomUUID().replaceAll('-', ''),
  });
  await guest.goto(`/v/${token}`);
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  await guest.getByRole('button', { name: 'Turn on sound alerts' }).click();
  await expect(guest.getByText('Sound alerts are on. Keep this page open.')).toBeVisible();
  expect(await counts()).toEqual({ beeps: 1, buzzes: 0 });

  const staff = await staffToken();
  const called = await rpc<{ id: string; version: number }>(
    'call_next',
    { p_queue_id: queue.id, p_counter_id: demo.counters.chair1, p_idempotency_key: randomUUID() },
    staff,
  );
  const takeover = guest.getByRole('alertdialog', { name: "It's your turn" });
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  await expect(takeover).toContainText('Go to Chair 1');
  await expect(guest.getByRole('button', { name: 'Got it' })).toBeFocused();
  expect(await counts()).toEqual({ beeps: 4, buzzes: 1 });
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Got it' }).click();
  await expect(takeover).toHaveCount(0);

  await rpc(
    'transition_visit',
    {
      p_visit_id: called.id,
      p_action: 'recall',
      p_expected_version: called.version,
      p_idempotency_key: randomUUID(),
    },
    staff,
  );
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  expect(await counts()).toEqual({ beeps: 7, buzzes: 2 });
});

test('a guest who was called before turning on sound can still turn it on for a recall', async ({
  devices,
}) => {
  const { guest } = devices;
  await guest.addInitScript(() => {
    const w = window as unknown as { beeps: number };
    w.beeps = 0;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      w.beeps++;
      return create.call(this);
    };
  });
  const beeps = () => guest.evaluate(() => (window as unknown as { beeps: number }).beeps);

  const queue = await freshQueue();
  const { token } = await rpc<{ token: string }>('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Sam',
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: randomUUID().replaceAll('-', ''),
  });
  await guest.goto(`/v/${token}`);
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  const staff = await staffToken();
  const called = await rpc<{ id: string; version: number }>(
    'call_next',
    { p_queue_id: queue.id, p_counter_id: demo.counters.chair1, p_idempotency_key: randomUUID() },
    staff,
  );
  const takeover = guest.getByRole('alertdialog', { name: "It's your turn" });
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  await guest.getByRole('button', { name: 'Got it' }).click();

  await guest.getByRole('button', { name: 'Turn on sound alerts' }).click();
  await expect(guest.getByText('Sound alerts are on. Keep this page open.')).toBeVisible();
  expect(await beeps()).toBe(1);

  await rpc(
    'transition_visit',
    {
      p_visit_id: called.id,
      p_action: 'recall',
      p_expected_version: called.version,
      p_idempotency_key: randomUUID(),
    },
    staff,
  );
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  expect(await beeps()).toBe(4);
});
