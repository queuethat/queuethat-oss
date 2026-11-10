import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { testUsers } from './support/users.ts';

// G4 (#54): the guest status page stays live and says when it isn't.

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

const join = (name: string) =>
  rpc<{ token: string }>('join_queue', {
    p_queue_id: demo.queues.kids,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    // Its own phone: every e2e request shares one IP, so the per-phone join cap (#441) would trip.
    p_device_key: randomUUID().replaceAll('-', ''),
  });

async function staffToken(): Promise<string> {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(testUsers.staff),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

test('position updates within 3 s when staff call the guest ahead (AC1)', async ({ devices }) => {
  const { guest } = devices;
  await join('Ahead');
  const { token } = await join('Behind');
  await guest.goto(`/v/${token}`);

  const position = guest.getByTestId('position');
  await expect(position).toBeVisible();
  // Subscribed before the change, so the update below can only come from the pulse.
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  const before = Number((await position.textContent())!.match(/\d+/)![0]);
  await expectNoSeriousA11yViolations(guest);

  await rpc(
    'call_next',
    {
      p_queue_id: demo.queues.kids,
      p_counter_id: demo.counters.chair1,
      p_idempotency_key: randomUUID(),
    },
    await staffToken(),
  );

  await expect
    .poll(async () => Number((await position.textContent())!.match(/\d+/)![0]), { timeout: 3_000 })
    .toBeLessThan(before);
});

test('after 2 minutes offline the estimate greys out with "as of" (AC2)', async ({ devices }) => {
  const { guest } = devices;
  const { token } = await join('Offline');
  await guest.clock.install();
  await guest.goto(`/v/${token}`);
  await expect(guest.getByTestId('eta')).toBeVisible();
  await expect(guest.getByText(/Last updated/)).toHaveCount(0);

  await guest.context().setOffline(true);
  await guest.clock.fastForward('02:30');

  await expect(guest.getByText(/Last updated \d{2}:\d{2}/)).toBeVisible();
  await expect(guest.getByTestId('eta')).toHaveClass(/opacity-60/);
  await expect(guest.locator('[data-state="offline"]')).toBeVisible();
  await guest.context().setOffline(false);
});

test('an unknown link says it has expired', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto('/v/not-a-real-token');
  await expect(guest.getByText('This link has expired')).toBeVisible();
});
