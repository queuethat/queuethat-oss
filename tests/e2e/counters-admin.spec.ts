import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// A7 (#47): managers and up add, rename and archive counters; calls name the counter.

test('staff see counters without controls to change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/counters');
  await expect(staff.getByRole('heading', { name: 'Chair 1' })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Add a resource' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test("AC1: a call to counter 'Chair 2' sends the guest to Chair 2", async ({ devices }) => {
    const { staff, guest } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/counters');
    await expect(staff.getByText('No counters yet')).toBeVisible();
    await staff.getByRole('button', { name: 'Add a resource' }).click();
    await staff.getByLabel('Resource name').fill('Chair 2');
    await staff.getByRole('button', { name: 'Save resource' }).click();
    await expect(staff.getByTestId('counter')).toHaveText(/Chair 2/);
    await expectNoSeriousA11yViolations(staff);

    // The console (C1) and TV (T1) screens aren't built yet, so staff call through the same RPC
    // the console will use, and the guest's status page and the display snapshot show the result.
    const [[location], [counter]] = (await readAs(email, [
      'locations?select=id,org_id',
      'counters?select=id',
    ])) as [{ id: string; org_id: string }[], { id: string }[]];
    const queue = await restAs(email, 'queues', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ org_id: location!.org_id, location_id: location!.id, name: 'Q' }),
    }).then(async (r) => ((await r.json()) as { id: string }[])[0]!);
    const { token } = await rpc<{ token: string }>(null, 'join_queue', {
      p_queue_id: queue.id,
      p_service_id: null,
      p_name: 'Sam',
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
    });
    await rpc(email, 'call_next', {
      p_queue_id: queue.id,
      p_counter_id: counter!.id,
      p_idempotency_key: randomUUID(),
    });

    await guest.goto(`/v/${token}`);
    await expect(guest.getByText("It's your turn. Please go to Chair 2.")).toBeVisible();
    const snapshot = await rpc<{ queues: { now_serving: { counter_label: string }[] }[] }>(
      email,
      'display_snapshot',
      { p_location_id: location!.id },
    );
    expect(snapshot.queues[0]!.now_serving[0]!.counter_label).toBe('Chair 2');
  });

  test('editing and archiving a resource', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/counters');
    await staff.getByRole('button', { name: 'Add a resource' }).click();
    await staff.getByLabel('Resource name').fill('Desk');
    await staff.getByRole('button', { name: 'Save resource' }).click();

    await staff.getByRole('button', { name: 'Edit' }).click();
    await staff.getByLabel('Resource name').fill('Desk A');
    await staff.getByRole('button', { name: 'Save resource' }).click();
    await expect(staff.getByTestId('counter')).toHaveText(/Desk A/);

    await staff.getByRole('button', { name: 'Archive' }).click();
    await staff.getByRole('button', { name: 'Yes, archive' }).click();
    await expect(staff.getByText('No counters yet')).toBeVisible();
    const [counters] = await readAs(email, ['counters?select=label,archived_at']);
    expect(counters).toEqual([{ label: 'Desk A', archived_at: expect.any(String) }]);
  });

  test('run 5: a new counter is listed after the ones already there', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/counters');
    for (const label of ['Window', 'Desk']) {
      await staff.getByRole('button', { name: 'Add a resource' }).click();
      await staff.getByLabel('Resource name').fill(label);
      await staff.getByRole('button', { name: 'Save resource' }).click();
      await expect(staff.getByTestId('counter').filter({ hasText: label })).toBeVisible();
    }
    // Not alphabetical: Desk was added last.
    await expect(staff.getByTestId('counter')).toHaveText([/Window/, /Desk/]);
    const [counters] = await readAs(email, ['counters?select=label,sort_order&order=sort_order']);
    expect(counters).toEqual([
      { label: 'Window', sort_order: 1 },
      { label: 'Desk', sort_order: 2 },
    ]);
  });

  test("an owner can't rename another business's counter", async () => {
    const { email } = await ownerOfNewBusiness();
    const response = await restAs(email, `counters?id=eq.${demo.counters.chair2}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ label: 'Hijacked' }),
    });
    expect(await response.json()).toEqual([]);
  });
});

/** Calls an `api` RPC as `email`, or as anon when `email` is null. */
async function rpc<T = unknown>(email: string | null, fn: string, args: object): Promise<T> {
  const init = {
    method: 'POST',
    headers: { 'content-profile': 'api', 'accept-profile': 'api' },
    body: JSON.stringify(args),
  };
  const { url, anonKey } = supabaseEnv();
  const response = email
    ? await restAs(email, `rpc/${fn}`, init)
    : await fetch(`${url}/rest/v1/rpc/${fn}`, {
        ...init,
        headers: { ...init.headers, apikey: anonKey, 'content-type': 'application/json' },
      });
  expect(response.ok, await response.clone().text()).toBe(true);
  return (await response.json()) as T;
}
