import { createClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';
import { runTenantAction } from './support/platform-actions.ts';
import { signedInOperator } from './support/totp.ts';

// PLT15 (#421): the whole operator journey, on a business of its own so suspending it never
// touches another spec. The steps follow docs/ops/platform-runbook.md.
test.use({ staffUser: null });

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A REST call with the page's own signed-in session, as the console makes it. */
async function asPage(page: Page, path: string, init: RequestInit = {}): Promise<Response> {
  const session = await page.evaluate(() => localStorage.getItem('qm.auth'));
  const { access_token } = JSON.parse(session ?? '{}') as { access_token?: string };
  return fetch(`${env.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.anonKey,
      authorization: `Bearer ${access_token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

/** How many of the org's queues the page's user can read under RLS. */
async function queuesVisible(page: Page, orgId: string): Promise<number> {
  const response = await asPage(page, `queues?select=id&org_id=eq.${orgId}`, {
    headers: { 'accept-profile': 'app' },
  });
  expect(response.ok).toBe(true);
  return ((await response.json()) as unknown[]).length;
}

test('operator journey: enrol, granted access, suspend and restore, access ends with the grant', async ({
  devices,
  browser,
}) => {
  test.slow();
  const { staff: operator, guest } = devices;

  // A business with one open queue.
  const { email: ownerEmail, slug } = await ownerOfNewBusiness();
  const [[org], [location]] = (await readAs(ownerEmail, [
    'organizations?select=id',
    'locations?select=id',
  ])) as [[{ id: string }], [{ id: string }]];
  const { data: queue, error } = await service
    .schema('app')
    .from('queues')
    .insert({ org_id: org.id, location_id: location.id, name: 'Walk-ins', ticket_prefix: 'J' })
    .select('id')
    .single();
  if (error) throw error;
  const { error: serviceError } = await service.schema('app').from('services').insert({
    org_id: org.id,
    location_id: location.id,
    queue_id: queue.id,
    name: 'Cut',
    expected_minutes: 15,
  });
  if (serviceError) throw serviceError;

  // 1. The operator sets up two-step sign-in. Without a grant, tenant data stays closed.
  await signedInOperator(operator);
  expect(await queuesVisible(operator, org.id)).toBe(0);

  // 2. The owner gives read-only support access.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signInTo(owner, ownerEmail, '/admin/settings/support');
  await owner.getByLabel('What support can do').selectOption('read');
  await owner.getByLabel('For how many hours').fill('1');
  await owner.getByLabel('Reason').fill('Display shows the wrong ticket');
  await owner.getByRole('button', { name: 'Give access' }).click();
  await expect(owner.getByTestId('support-status')).toContainText('until');

  // 3. The operator opens the org and can now read its data.
  await operator.goto(`/platform/orgs/${org.id}`);
  await expect(operator.getByTestId('support-grant')).toBeVisible();
  expect(await queuesVisible(operator, org.id)).toBe(1);

  // A guest joins before the suspension.
  await guest.goto(`/q/${slug}`);
  await guest.getByLabel('First name').fill('Robin');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const statusUrl = guest.url();
  await expect(guest.getByTestId('position')).toBeVisible();

  // 4. The operator suspends: a new join is refused, the waiting guest keeps their status.
  await runTenantAction(operator, {
    trigger: 'Suspend business',
    confirm: 'Suspend',
    slug,
    reason: 'E2E journey',
  });
  await expect(operator.getByRole('heading', { level: 1 })).toContainText('Suspended');
  // Another phone: the first one is sent back to its own visit from the join page.
  const newcomerContext = await browser.newContext();
  const newcomer = await newcomerContext.newPage();
  await newcomer.goto(`/q/${slug}`);
  await expect(newcomer.getByText("This queue isn't taking guests right now.")).toBeVisible();
  await guest.goto(statusUrl);
  await expect(guest.getByTestId('position')).toBeVisible();

  // 5. The operator restores it, and joining works again.
  await runTenantAction(operator, {
    trigger: 'Restore business',
    confirm: 'Restore',
    slug,
    reason: 'E2E journey',
  });
  await expect(operator.getByRole('heading', { level: 1 })).not.toContainText('Suspended');
  await newcomer.reload();
  await expect(newcomer.getByText("This queue isn't taking guests right now.")).toHaveCount(0);
  await expect(newcomer.getByRole('button', { name: 'Join the queue' })).toBeEnabled();

  // 6. The owner ends support access, and the operator loses it at once.
  await owner.getByRole('button', { name: 'End support access' }).click();
  await owner.getByRole('button', { name: 'Yes, end access' }).click();
  await expect(owner.getByTestId('support-status')).toHaveText('Support has no access.');
  expect(await queuesVisible(operator, org.id)).toBe(0);
  await operator.reload();
  await expect(operator.getByRole('heading', { name: 'Support access' })).toBeVisible();
  await expect(operator.getByTestId('support-grant')).toHaveCount(0);

  await Promise.all([ownerContext.close(), newcomerContext.close()]);
});
