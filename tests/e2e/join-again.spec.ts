import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { freshQueue } from './support/queues.ts';
import { supabaseEnv } from './support/env.ts';
import { enableDemoSms } from './support/sms.ts';

// 4-GX1 (#384): the join page remembers the last join in this browser only.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test.beforeEach(() => enableDemoSms(service));

test('AC1: a returning guest finds name and queue prefilled, consent unticked, and can forget', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();

  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest.getByText('Welcome back')).toHaveCount(0);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Leah');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await guest.getByRole('button', { name: 'Leave the line' }).click();
  await guest.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(guest.getByText('You left the line.')).toBeVisible();

  await guest.getByRole('link', { name: 'Join again' }).click();
  await expect(guest.getByText('Welcome back, Leah.')).toBeVisible();
  await expect(guest.getByLabel('First name')).toHaveValue('Leah');
  await expect(guest.getByLabel('Queue')).toHaveValue(queue.id);
  for (const box of await guest.getByRole('checkbox').all()) await expect(box).not.toBeChecked();

  // Nothing but the browser holds it: the stored entry has no token and no contact data.
  const stored = await guest.evaluate(() => localStorage.getItem('qm:join-history'));
  expect(Object.keys(JSON.parse(stored!)[0]).sort()).toEqual([
    'at',
    'name',
    'queueId',
    'serviceId',
    'slug',
  ]);

  await guest.getByRole('button', { name: 'Forget my history' }).click();
  await expect(guest.getByLabel('First name')).toHaveValue('');
  await guest.reload();
  await expect(guest.getByText('Welcome back')).toHaveCount(0);
  await expect(guest.getByLabel('First name')).toHaveValue('');
});

test('AC2: with storage blocked the join page still works', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await guest.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Storage.prototype.getItem = blocked;
    Storage.prototype.setItem = blocked;
    Storage.prototype.removeItem = blocked;
  });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Sam');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
});
