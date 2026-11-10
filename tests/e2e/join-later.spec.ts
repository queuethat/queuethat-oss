import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { activateLaterVisits } from './support/console.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-J4 (#242): joining for later, from the guest's phone and on the staff console.

test.use({ staffUser: null });

/** A business of its own whose one queue takes join-later reservations. */
async function laterQueue() {
  const { email, slug } = await ownerOfNewBusiness();
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const response = await restAs(email, 'queues', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      org_id: loc!.org_id,
      location_id: loc!.id,
      name: 'Front desk',
      ticket_prefix: 'LTR',
      join_later_enabled: true,
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const [queue] = (await response.json()) as { id: string }[];
  // The service day rolls over at 04:00 local, and a later slot must fall on the same day. Put the
  // location in a fixed-offset zone where it is about noon right now, so the tests do not fail in
  // the hours before the rollover (join-later failed at 02:15Z with Berlin as the zone).
  const offset = 12 - new Date().getUTCHours();
  const tz = offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
  const moved = await restAs(email, `locations?id=eq.${loc!.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ tz }),
  });
  expect(moved.ok, await moved.clone().text()).toBe(true);
  return { email, slug, queueId: queue!.id };
}

/** A guest reserves a place `minutes` from now, the way the join page does. */
async function joinLater(queueId: string, name: string, minutes: number) {
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
      p_name: name,
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
      p_arrive_after: new Date(Date.now() + minutes * 60_000).toISOString(),
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

test('the console lists guests joining later in their own section', async ({ devices }) => {
  const { staff } = devices;
  const { email, queueId } = await laterQueue();
  await joinLater(queueId, 'Late Lena', 45);
  await signInTo(staff, email, '/staff');
  await staff.goto(`/staff?queue=${queueId}`);
  const later = staff.getByTestId('section-later');
  await expect(later).toContainText('Later today (1)');
  await expect(later).toContainText('Late Lena');
  await expect(later).toContainText(/Due \d/);
  await expect(staff.getByTestId('section-waiting')).not.toContainText('Late Lena');
});

test('AC1 and AC2: a guest joins for later, sees the scheduled state, then the line without reloading', async ({
  devices,
}) => {
  const { guest } = devices;
  const { slug, queueId } = await laterQueue();
  await guest.goto(`/q/${slug}`);
  const when = guest.getByLabel('When');
  await expect(when).toBeVisible();
  // Late in the evening at the location nothing fits "today": there is no choice to test.
  test.skip((await when.locator('option').count()) === 0, 'no later slot today');
  await when.selectOption('later');
  await expect(guest.getByLabel('Arrival time')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByLabel('First name').fill('Lena');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest.waitForURL(/\/v\//);

  await expect(guest.getByText(/You'll join the line at/)).toBeVisible();
  await expect(guest.getByText('Scheduled')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Leave the line' })).toBeVisible();
  await expect(guest.getByTestId('position')).toHaveCount(0);

  await activateLaterVisits(queueId);
  await expect(guest.getByTestId('position')).toBeVisible({ timeout: 45_000 });
  await expect(guest.getByText(/You'll join the line at/)).toHaveCount(0);
});
