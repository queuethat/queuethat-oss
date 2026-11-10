import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { signInAs } from './support/auth.ts';
import { supabaseEnv } from './support/env.ts';
import { uniqueEmail } from './support/mail.ts';

// 2B-ORG4 (#268): an owner of two locations switches between them and watches both on one page.
// The owner belongs to an organization of their own, so the demo location stays the only one demo staff see.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false },
});
// fullyParallel re-runs beforeAll for every test, even in one worker, so each run owns its names.
let email = '';
let suffix = '';
let queueB = '';

test.beforeAll(async () => {
  email = uniqueEmail('multi');
  suffix = randomUUID().slice(0, 6);
  const { data: user, error: userError } = await service.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (userError) throw userError;
  const app = service.schema('app');
  const { data: org, error } = await app
    .from('organizations')
    .insert({ name: `Multi ${suffix}` })
    .select('id')
    .single();
  if (error) throw error;
  const orgId = org.id as string;
  await app
    .from('memberships')
    .insert({ org_id: orgId, user_id: user.user.id, role: 'owner', display_name: 'Multi owner' });
  for (const name of ['Alpha', 'Bravo']) {
    const { data: location, error: locationError } = await app
      .from('locations')
      .insert({
        org_id: orgId,
        name: `${name} ${suffix}`,
        slug: `${name}-${suffix}`.toLowerCase(),
        tz: 'UTC',
      })
      .select('id')
      .single();
    if (locationError) throw locationError;
    const { data: queue, error: queueError } = await app
      .from('queues')
      .insert({
        org_id: orgId,
        location_id: location.id,
        name: `${name} line`,
        ticket_prefix: name[0],
      })
      .select('id')
      .single();
    if (queueError) throw queueError;
    if (name === 'Bravo') queueB = queue.id as string;
  }
});

test('AC1: switching location changes the console without a reload', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, { email, password: DEMO_PASSWORD });
  await page.goto('/staff');
  await expect(page.getByLabel('Location')).toBeVisible();
  await page.getByLabel('Location').selectOption({ label: `Bravo ${suffix}` });
  await expect(page.getByText('Bravo line').first()).toBeVisible();
  await expect(page.getByText('Alpha line')).toHaveCount(0);
  await context.close();
});

test('AC2: the overview tile of a location updates when a guest joins it', async ({ browser }) => {
  test.setTimeout(90_000); // the tile refreshes every 30 s
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, { email, password: DEMO_PASSWORD });
  await page.goto('/admin/overview');
  const tile = page.getByTestId(`overview-Bravo ${suffix}`);
  await expect(tile.getByTestId('overview-waiting')).toHaveText('0 people waiting');

  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  const added = await client.schema('api').rpc('staff_add_visit', {
    p_queue_id: queueB,
    p_service_id: null as unknown as string,
    p_name: 'Overview guest',
    p_phone_e164: '+14155550142',
    p_party_size: 1,
    p_idempotency_key: randomUUID(),
  });
  expect(added.error).toBeNull();

  await expect(tile.getByTestId('overview-waiting')).toHaveText('1 person waiting', {
    timeout: 35_000,
  });
  await tile.click();
  await expect(page).toHaveURL(/\/admin$/);
  await context.close();
});
