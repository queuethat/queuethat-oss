import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import {
  accessToken,
  confirmedAccount,
  ownerOfNewBusiness,
  readAs,
  restAs,
  signInTo,
} from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// PLT14 (#420): owners give and end support access; everyone on the team sees when it is open.
// Every test uses a business of its own: a grant on the demo org would put a banner on every
// other spec's pages.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function userId(email: string): Promise<string> {
  const token = await accessToken(email);
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string })
    .sub;
}

async function orgOf(email: string): Promise<string> {
  const [orgs] = (await readAs(email, ['organizations?select=id'])) as [{ id: string }[]];
  return orgs[0]!.id;
}

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC2: a live grant shows on every staff page and goes away when the owner ends it', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await staff.setViewportSize({ width: 1280, height: 900 });
    await signInTo(staff, email, '/admin');
    const nav = staff.getByRole('navigation', { name: 'Admin' });
    await nav.getByRole('button', { name: 'Account' }).click();
    await nav.getByRole('link', { name: 'Support access' }).click();
    await expect(staff.getByTestId('support-status')).toHaveText('Support has no access.');
    await expect(staff.getByTestId('support-banner')).toHaveCount(0);

    await staff.getByLabel('What support can do').selectOption('act');
    await staff.getByLabel('For how many hours').fill('2');
    await staff.getByLabel('Reason').fill('Tickets skip a number');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Give access' }).click();
    await expect(staff.getByTestId('support-status')).toContainText(
      'Support can see and change this business until',
    );
    const banner = staff.getByTestId('support-banner');
    await expect(banner).toContainText('Support access');
    await expect(banner).toContainText('Reason: Tickets skip a number');

    for (const path of ['/admin', '/staff', '/admin/queues']) {
      await staff.goto(path);
      await expect(staff.getByTestId('support-banner')).toContainText('can see and change');
    }

    await staff.goto('/admin/settings/support');
    await staff.getByRole('button', { name: 'End support access' }).click();
    await staff.getByRole('button', { name: 'Yes, end access' }).click();
    await expect(staff.getByTestId('support-status')).toHaveText('Support has no access.');
    await expect(staff.getByTestId('support-banner')).toHaveCount(0);
    await expect(staff.getByTestId('support-grant').first()).toContainText('Ended by an owner');
  });

  test('AC3: a past break-glass shows in the history with its reason', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    const hour = 3_600_000;
    const { error } = await service
      .schema('app')
      .from('support_grants')
      .insert({
        org_id: await orgOf(email),
        grantee: await userId(email),
        scope: 'read',
        break_glass: true,
        reason: 'Outage on 25 Oct',
        created_at: new Date(Date.now() - 3 * hour).toISOString(),
        expires_at: new Date(Date.now() - 2.5 * hour).toISOString(),
      });
    expect(error).toBeNull();

    await signInTo(staff, email, '/admin/settings/support');
    const row = staff.getByTestId('support-grant');
    await expect(row).toContainText('Emergency');
    await expect(row).toContainText('Reason: Outage on 25 Oct');
    await expect(row).toContainText('Expired');
    // Over, so no banner.
    await expect(staff.getByTestId('support-banner')).toHaveCount(0);
  });

  test("an owner can't open or read support access for another business", async () => {
    const { email } = await ownerOfNewBusiness();
    const grant = await restAs(email, 'rpc/grant_support_access', {
      method: 'POST',
      headers: { 'content-profile': 'api' },
      body: JSON.stringify({ p_org_id: demo.orgId, p_scope: 'act', p_hours: 1, p_reason: 'x' }),
    });
    expect(grant.status).toBe(403);
    const revoke = await restAs(email, 'rpc/revoke_support_access', {
      method: 'POST',
      headers: { 'content-profile': 'api' },
      body: JSON.stringify({ p_org_id: demo.orgId }),
    });
    expect(revoke.status).toBe(403);
    const [rows] = await readAs(email, [`support_grants?org_id=eq.${demo.orgId}`]);
    expect(rows).toEqual([]);
  });
});

test.describe('as a manager', () => {
  test.use({ staffUser: null });

  test('AC1: the page is read-only and the grant form is hidden', async ({ devices }) => {
    const { staff } = devices;
    const { email: owner } = await ownerOfNewBusiness();
    const manager = await confirmedAccount();
    const { error } = await service
      .schema('app')
      .from('memberships')
      .insert({ org_id: await orgOf(owner), user_id: await userId(manager), role: 'manager' });
    expect(error).toBeNull();
    await restAs(owner, 'rpc/grant_support_access', {
      method: 'POST',
      headers: { 'content-profile': 'api' },
      body: JSON.stringify({
        p_org_id: await orgOf(owner),
        p_scope: 'read',
        p_hours: 1,
        p_reason: 'Check the TV',
      }),
    });

    await signInTo(staff, manager, '/admin/settings/support');
    await expect(staff.getByText('Only owners can give or end support access.')).toBeVisible();
    await expect(staff.getByTestId('support-status')).toContainText('(read only)');
    await expect(staff.getByTestId('support-banner')).toContainText('Reason: Check the TV');
    await expect(staff.getByRole('button', { name: 'Give access' })).toHaveCount(0);
    await expect(staff.getByRole('button', { name: 'End support access' })).toHaveCount(0);
    await expect(staff.getByLabel('Reason')).toHaveCount(0);
    await expectNoSeriousA11yViolations(staff);
  });
});
