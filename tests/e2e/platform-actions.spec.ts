import { createClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { NEW_ACCOUNT_PASSWORD, ownerOfNewBusiness, readAs } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';
import { runTenantAction } from './support/platform-actions.ts';
import { signedInOperator } from './support/totp.ts';

// PLT12 (#418): the operator's tenant actions, from the org detail page.
test.use({ staffUser: null });

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Business {
  id: string;
  slug: string;
  ownerEmail: string;
}

/** A fresh business with one open queue, so a guest can join it. */
async function business(): Promise<Business> {
  const { email, slug } = await ownerOfNewBusiness();
  const [[org], [location]] = (await readAs(email, [
    'organizations?select=id',
    'locations?select=id',
  ])) as [[{ id: string }], [{ id: string }]];
  const { data: queue, error } = await service
    .schema('app')
    .from('queues')
    .insert({ org_id: org.id, location_id: location.id, name: 'Walk-ins', ticket_prefix: 'A' })
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
  return { id: org.id, slug, ownerEmail: email };
}

/** Whether a guest on a fresh phone is offered the join button for this business. */
async function joinable(page: Page, slug: string): Promise<boolean> {
  await page.goto(`/q/${slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return (await page.getByText("This queue isn't taking guests right now.").count()) === 0;
}

test('suspend asks for a reason and the slug, closes only that business, and shows the audit row (AC1-3, axe)', async ({
  devices,
  browser,
}) => {
  test.slow();
  const { staff: operator } = devices;
  const [a, b] = [await business(), await business()];
  const suspendCalls: string[] = [];
  operator.on('request', (request) => {
    if (request.url().includes('rpc/platform_set_org_status')) suspendCalls.push(request.url());
  });
  await signedInOperator(operator);
  await operator.goto(`/platform/orgs/${a.id}`);
  await expect(operator.getByRole('heading', { name: 'Actions on this business' })).toBeVisible();
  await expectNoSeriousA11yViolations(operator);

  // AC1 and AC3: no reason, or the wrong slug, and confirm stays off and nothing is called.
  await operator.getByRole('button', { name: 'Suspend business' }).click();
  const dialog = operator.getByRole('dialog');
  await expect(dialog.getByText(/isn't taking guests right now/)).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Suspend', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/^Type /).fill(a.slug);
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Reason').fill('Abuse reports');
  await dialog.getByLabel(/^Type /).fill(`${a.slug}x`);
  await expect(confirm).toBeDisabled();
  expect(suspendCalls).toHaveLength(0);
  await dialog.getByLabel(/^Type /).fill(a.slug);
  await confirm.click();

  // The audit row comes back, and the badge changes.
  await expect(operator.getByTestId('result-status')).toContainText('Recorded: org.suspend');
  await expect(operator.getByTestId('result-status')).toContainText('Reason: Abuse reports');
  await expect(operator.getByRole('heading', { level: 1 })).toContainText('Suspended');
  expect(suspendCalls).toHaveLength(1);

  // AC2: the directory badge, the guests' page. Cross-tenant: the other business is untouched.
  await operator.goto('/platform');
  await operator.getByLabel('Search').fill(a.ownerEmail);
  await operator.getByRole('button', { name: 'Search' }).click();
  await expect(operator.getByTestId('tenant')).toHaveCount(1);
  await expect(operator.getByTestId('tenant')).toContainText('Suspended');
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  expect(await joinable(guest, a.slug)).toBe(false);
  expect(await joinable(guest, b.slug)).toBe(true);
  const { data: other } = await service
    .schema('app')
    .from('organizations')
    .select('status')
    .eq('id', b.id)
    .single();
  expect(other?.status).toBe('active');

  // Restore.
  await operator.goto(`/platform/orgs/${a.id}`);
  await runTenantAction(operator, {
    trigger: 'Restore business',
    confirm: 'Restore',
    slug: a.slug,
    reason: 'Resolved',
  });
  await expect(operator.getByTestId('result-status')).toContainText('Recorded: org.unsuspend');
  expect(await joinable(guest, a.slug)).toBe(true);
  await guestContext.close();
});

test('transfer, break-glass, sign-out and revoke each run from the page and show what was recorded', async ({
  devices,
}) => {
  test.slow();
  const { staff: operator } = devices;
  const a = await business();
  const staffEmail = `transfer-${crypto.randomUUID().slice(0, 8)}@e2e.test`;
  const { data: created, error } = await service.auth.admin.createUser({
    email: staffEmail,
    password: NEW_ACCOUNT_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: memberError } = await service
    .schema('app')
    .from('memberships')
    .insert({ org_id: a.id, user_id: created.user.id, role: 'staff' });
  if (memberError) throw memberError;

  await signedInOperator(operator);
  await operator.goto(`/platform/orgs/${a.id}`);

  await operator.getByRole('button', { name: 'Transfer ownership' }).click();
  await operator.getByRole('dialog').getByLabel('New owner').selectOption(staffEmail);
  await operator.getByRole('dialog').getByLabel('Reason').fill('Owner left');
  await operator
    .getByRole('dialog')
    .getByLabel(/^Type /)
    .fill(a.slug);
  await operator.getByRole('dialog').getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(operator.getByTestId('result-transfer')).toContainText(
    'Recorded: org.transfer_ownership',
  );
  await expect(
    operator.getByRole('row', { name: new RegExp(`${staffEmail}.*owner`) }),
  ).toBeVisible();

  await runTenantAction(operator, {
    trigger: 'Open break-glass access',
    confirm: 'Open access',
    slug: a.slug,
    reason: 'Legal request',
  });
  await expect(operator.getByTestId('result-breakGlass')).toContainText('Recorded:');
  await expect(operator.getByTestId('support-grant')).toContainText('Break-glass');

  await runTenantAction(operator, {
    trigger: 'Sign everyone out',
    confirm: 'Sign out',
    slug: a.slug,
    reason: 'Compromised',
  });
  await expect(operator.getByTestId('result-signOut')).toContainText(
    /\d+ (person|people) signed out of \d+ sessions?\./,
  );

  await runTenantAction(operator, {
    trigger: 'Revoke all screens',
    confirm: 'Revoke screens',
    slug: a.slug,
    reason: 'Compromised',
  });
  await expect(operator.getByTestId('result-revokeDevices')).toContainText(
    /\d+ screens? revoked\./,
  );
});
