import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { withPublicJoin } from './support/public-join.ts';
import { freshQueue } from './support/queues.ts';

// 2A-JN3 (#113): the join page submits through the public-join Edge Function. CI has no edge
// runtime, so the function's own handler and Supabase wiring run in Node against the real
// database (the same arrangement as join-captcha.spec.ts), behind page.route.

test('with the pow provider a guest joins without any interactive challenge', async ({
  devices,
}) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'pow');
  const queue = await freshQueue();
  const request = guest.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/functions/v1/public-join'),
  );

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Robin');
  // The check runs in the background while the form is filled; no widget, nothing to solve.
  await expect(guest.locator('iframe')).toHaveCount(0);
  await expect(guest.getByText('Check complete.')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const body = (await request).postDataJSON() as { captcha: string; idempotencyKey: string };
  expect(body.captcha).toContain('~');
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});

test('with the dev provider the join goes through the function too', async ({ devices }) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'dev');
  const queue = await freshQueue();
  let viaFunction = 0;
  let direct = 0;
  guest.on('request', (r) => {
    if (r.url().endsWith('/functions/v1/public-join') && r.method() === 'POST') viaFunction++;
    if (r.url().endsWith('/rpc/join_queue')) direct++;
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Robin');
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  expect(viaFunction).toBe(1);
  expect(direct).toBe(0);
});

test('a 429 is announced politely with a countdown and keeps the form', async ({ devices }) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'dev', (deps) => ({
    ...deps,
    hit: (key, ...rest) =>
      key.startsWith('join:') ? Promise.resolve(false) : deps.hit(key, ...rest),
  }));
  const queue = await freshQueue();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Robin');
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  const notice = guest.getByRole('status').filter({ hasText: 'Too many tries from this network' });
  await expect(notice).toHaveText(/Try again in \d+ minutes?\./);
  await expect(notice).toHaveAttribute('aria-live', 'polite');
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();
  await expect(guest.getByLabel('First name')).toHaveValue('Robin');
  await expectNoSeriousA11yViolations(guest);
});

// 2A-J15B (#118): every person of a group is its own public-join call and spends its own
// proof-of-work answer, so the page solves a fresh one between people.
test('a group joins through the function with a fresh proof for each person', async ({
  devices,
}) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'pow');
  const queue = await freshQueue();
  const bodies: { captcha: string; groupKey: string | null; idempotencyKey: string }[] = [];
  guest.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/functions/v1/public-join')) {
      bodies.push(r.postDataJSON());
    }
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Parent');
  await guest.getByRole('button', { name: 'Add another person' }).click();
  await guest.getByLabel('Name of person 2').fill('Child');
  await expect(guest.getByText('Check complete.')).toBeVisible();
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expect(guest.getByRole('tab')).toHaveCount(2);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.captcha).not.toBe(bodies[0]!.captcha);
  expect(bodies[1]!.idempotencyKey).not.toBe(bodies[0]!.idempotencyKey);
  expect(bodies[0]!.groupKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(bodies[1]!.groupKey).toBe(bodies[0]!.groupKey);
});
