import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// G-4 (#124): a called guest says they are on the way and staff see it; a waiting guest asks for
// more time and the page shows the new place. Both answers come from the database.

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

async function join(queueId: string, name: string): Promise<string> {
  const { token } = await rpc<{ token: string }>('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: null,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
    p_device_key: randomUUID().replaceAll('-', ''),
  });
  return token;
}

test('AC1: a called guest taps "I\'m on my way" and staff see "On the way" within 3 s', async ({
  devices,
}) => {
  const { guest, staff } = devices;
  const queue = await freshQueue();
  const token = await join(queue.id, 'Ona');
  await openQueue(staff, queue.id);

  await guest.goto(`/v/${token}`);
  await expect(guest.getByTestId('ticket')).toBeVisible();
  // Waiting guests are not "on their way" to anything yet.
  await expect(guest.getByRole('button', { name: "I'm on my way" })).toHaveCount(0);

  await rpc(
    'call_next',
    { p_queue_id: queue.id, p_counter_id: demo.counters.chair1, p_idempotency_key: randomUUID() },
    await staffToken(),
  );
  const takeover = guest.getByRole('alertdialog', { name: "It's your turn" });
  await expect(takeover).toBeVisible({ timeout: 3_000 });
  await expectNoSeriousA11yViolations(guest);

  await takeover.getByRole('button', { name: "I'm on my way" }).click();
  await expect(
    takeover.getByRole('button', { name: 'On the way. The staff know.' }),
  ).toBeDisabled();
  await expect(staff.getByTestId('on-the-way-badge')).toHaveText('On the way', { timeout: 3_000 });
});

test('AC2: "I need more time" at position 2 shows the new position within 3 s, and the count runs down', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await join(queue.id, 'First');
  const token = await join(queue.id, 'Second');
  await join(queue.id, 'Third');
  await join(queue.id, 'Fourth');
  await join(queue.id, 'Fifth');
  await join(queue.id, 'Sixth');

  await guest.goto(`/v/${token}`);
  await expect(guest.getByTestId('position')).toContainText('2');
  await expect(guest.getByTestId('snoozes-left')).toContainText('2 extensions left');

  await guest.getByRole('button', { name: 'I need more time' }).click();
  await expect(guest.getByTestId('position')).toContainText('4', { timeout: 3_000 });
  await expect(guest.getByTestId('snoozes-left')).toContainText('1 extension left');

  await guest.getByRole('button', { name: 'I need more time' }).click();
  await expect(guest.getByTestId('position')).toContainText('6', { timeout: 3_000 });
  await expect(guest.getByTestId('snoozes-left')).toHaveText('No more extensions');
  await expect(guest.getByRole('button', { name: 'I need more time' })).toBeDisabled();
});
