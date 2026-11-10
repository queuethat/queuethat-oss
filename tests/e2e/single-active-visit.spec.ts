import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-J2 (#240): the one-active-visit rule, its setting, and the way out for a blocked guest.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = () => service.schema('app');

/** A business with the rule on across locations and a queue at each of two locations. */
async function twoLocations() {
  const { email, slug } = await ownerOfNewBusiness();
  const { data: first, error } = await app()
    .from('locations')
    .select('id, org_id, tz')
    .eq('slug', slug)
    .single();
  if (error) throw error;
  const secondSlug = `second-${randomUUID().slice(0, 8)}`;
  const { data: second, error: e2 } = await app()
    .from('locations')
    .insert({ org_id: first.org_id, name: 'Second site', slug: secondSlug, tz: first.tz })
    .select('id')
    .single();
  if (e2) throw e2;
  for (const [location_id, name] of [
    [first.id, 'Queue A'],
    [second.id, 'Queue B'],
  ] as const) {
    const { error: e3 } = await app()
      .from('queues')
      .insert({ org_id: first.org_id, location_id, name, ticket_prefix: name.slice(-1) });
    if (e3) throw e3;
  }
  const set = await restAs(email, `organizations?id=eq.${first.org_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ single_active_visit: 'org' }),
  });
  expect(set.ok, await set.clone().text()).toBe(true);
  return { email, slugA: slug, slugB: secondSlug, orgId: first.org_id as string };
}

test('AC1: a guest in Queue A is told so at Queue B, leaves A and joins B', async ({ devices }) => {
  const { guest } = devices;
  const loc = await twoLocations();
  await guest.goto(`/q/${loc.slugA}`);
  await guest.getByLabel('First name').fill('Ada');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest.waitForURL(/\/v\//);
  // WebKit aborts a goto that lands while the status page's lazy chunks are still loading.
  await guest.waitForLoadState('networkidle');
  const ticket = guest.url();

  await guest.goto(`/q/${loc.slugB}`);
  await guest.getByLabel('First name').fill('Ada');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  const notice = guest.getByRole('alert').filter({ hasText: 'already waiting in Queue A' });
  await expect(notice).toBeVisible();
  await expectNoSeriousA11yViolations(guest);

  await notice.getByRole('button', { name: 'Leave that queue' }).click();
  await guest.getByRole('dialog').getByRole('button', { name: 'Leave that queue' }).click();
  await expect(notice).toHaveCount(0);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest.waitForURL(/\/v\//);
  expect(guest.url()).not.toBe(ticket);
});

test('a guest can go back to the ticket instead', async ({ devices }) => {
  const { guest } = devices;
  const loc = await twoLocations();
  await guest.goto(`/q/${loc.slugA}`);
  await guest.getByLabel('First name').fill('Bo');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest.waitForURL(/\/v\//);
  // WebKit aborts a goto that lands while the status page's lazy chunks are still loading.
  await guest.waitForLoadState('networkidle');
  const ticket = guest.url();
  await guest.goto(`/q/${loc.slugB}`);
  await guest.getByLabel('First name').fill('Bo');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest.getByRole('button', { name: 'Open my ticket' }).click();
  await guest.waitForURL(ticket);
});

test('AC2: only admins and owners can change the rule', async ({ devices }) => {
  const { staff } = devices;
  const loc = await twoLocations();
  await signInTo(staff, loc.email, '/admin/queues');
  const rule = staff.getByLabel('Rule');
  await expect(rule).toBeEnabled();
  await rule.selectOption('location');
  await expect(rule).toHaveValue('location');
  await expect
    .poll(async () => {
      const [[org]] = (await readAs(loc.email, ['organizations?select=single_active_visit'])) as [
        { single_active_visit: string }[],
      ];
      return org?.single_active_visit;
    })
    .toBe('location');
});

test('AC2: staff see the rule but cannot change it', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/queues');
  await expect(staff.getByLabel('Rule')).toBeDisabled();
  await expect(staff.getByText('Only admins and owners can change this.')).toBeVisible();
});
