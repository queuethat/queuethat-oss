import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';
import { guestJoins } from './support/console.ts';

// #68: the guided first-guest test on Today ticks as the owner joins and calls themselves.
test.use({ staffUser: null });

async function ownerWithQueue() {
  const { email } = await ownerOfNewBusiness();
  const [locations] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const created = await restAs(email, 'queues', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      org_id: locations[0]!.org_id,
      location_id: locations[0]!.id,
      name: 'Walk-ins',
      ticket_prefix: 'WLK',
      sort_order: 1000,
    }),
  });
  expect(created.ok, await created.clone().text()).toBe(true);
  const [queue] = (await created.json()) as { id: string }[];
  return { email, queueId: queue!.id };
}

test('the three steps tick live, and the test can be skipped for good', async ({ devices }) => {
  const { staff } = devices;
  const { email, queueId } = await ownerWithQueue();
  await signInTo(staff, email, '/admin');

  const test68 = staff.getByTestId('first-test');
  const done = test68.locator('li[data-done="true"]');
  await expect(test68.getByRole('heading', { name: 'Try it yourself in a minute' })).toBeVisible();
  await expect(done).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);

  // Step 2: a guest joins from a phone. The page is not reloaded.
  await guestJoins('Riz', queueId);
  await expect(done).toHaveCount(2);

  // Step 3: the guest is called.
  const [visits] = (await readAs(email, ['visits?select=id,version'])) as [
    { id: string; version: number }[],
  ];
  const called = await restAs(email, 'rpc/transition_visit', {
    method: 'POST',
    headers: { 'content-profile': 'api' },
    body: JSON.stringify({
      p_visit_id: visits[0]!.id,
      p_action: 'call',
      p_expected_version: visits[0]!.version,
      p_idempotency_key: randomUUID(),
    }),
  });
  expect(called.ok, await called.clone().text()).toBe(true);
  await expect(done).toHaveCount(3);
  await expect(test68.getByRole('heading', { name: 'Your line works' })).toBeVisible();

  // Dismissed per member, so it stays gone after a reload.
  await test68.getByRole('button', { name: 'Close' }).click();
  await expect(staff.getByTestId('first-test')).toHaveCount(0);
  await staff.reload();
  await expect(staff.getByTestId('setup-checklist')).toBeVisible();
  await expect(staff.getByTestId('first-test')).toHaveCount(0);
});

test('Skip hides the test before it is finished', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerWithQueue();
  await signInTo(staff, email, '/admin');
  await staff.getByRole('button', { name: 'Skip the test' }).click();
  await expect(staff.getByTestId('first-test')).toHaveCount(0);
  await staff.reload();
  await expect(staff.getByTestId('setup-checklist')).toBeVisible();
  await expect(staff.getByTestId('first-test')).toHaveCount(0);
});
