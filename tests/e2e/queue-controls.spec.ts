import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// C7 (#64): staff open, pause and close a queue from the console.

/** A guest joins `queueId` from their phone, as /q does, and gets their status link token. */
async function guestJoins(queueId: string): Promise<string> {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: queueId,
      p_service_id: null,
      p_name: 'Sam',
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { token: string }).token;
}

test('AC1: a paused queue shows paused on the join page and keeps its guests', async ({
  devices,
}) => {
  const { staff, guest } = devices;
  const queue = await freshQueue();
  const token = await guestJoins(queue.id);

  await staff.goto(`/staff?queue=${queue.id}`);
  const controls = staff.getByTestId('queue-controls');
  await expect(controls).toContainText('Open: guests can join');
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await controls.getByRole('button', { name: 'Pause' }).click();
  await expect(controls).toContainText('Paused: no new guests for now');
  await expect(controls).toContainText('Everyone already waiting keeps their place.');
  await expect(staff.getByRole('tab', { name: new RegExp(queue.name) })).toContainText('Paused');
  await expectNoSeriousA11yViolations(staff);

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await expect(
    guest.getByText('This queue is paused. Please check back in a few minutes.'),
  ).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();
  // The guest who was already in line is still waiting.
  await guest.goto(`/v/${token}`);
  await expect(guest.getByText("You're number 1 in line")).toBeVisible();

  await controls.getByRole('button', { name: 'Resume' }).click();
  await expect(controls).toContainText('Open: guests can join');
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeEnabled();
});

test('closing asks first, keeps the guests, and opening again lets people join', async ({
  devices,
}) => {
  const { staff, guest } = devices;
  const queue = await freshQueue();
  await guestJoins(queue.id);

  await staff.goto(`/staff?queue=${queue.id}`);
  const controls = staff.getByTestId('queue-controls');
  await controls.getByRole('button', { name: 'Close queue' }).click();
  // Nothing changes until the confirm tap (I-9); cancelling leaves it open.
  await staff.getByRole('button', { name: 'Keep open' }).click();
  await expect(controls).toContainText('Open: guests can join');

  await controls.getByRole('button', { name: 'Close queue' }).click();
  await expect(staff.getByRole('dialog')).toContainText('Guests already waiting stay in line.');
  await staff.getByRole('button', { name: 'Yes, close' }).click();
  await expect(controls).toContainText('Closed: no new guests');
  await expect(controls.getByRole('button', { name: 'Close queue' })).toHaveCount(0);
  await expect(staff.getByTestId('section-waiting').getByText('Sam')).toBeVisible();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await expect(guest.getByText('This queue is closed right now.')).toBeVisible();

  await controls.getByRole('button', { name: 'Open queue' }).click();
  await expect(controls).toContainText('Open: guests can join');
});
