import { demo } from '../fixtures/demo.ts';
import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { createMember } from './support/members.ts';
import { supabaseEnv } from './support/env.ts';
import { createClient } from '@supabase/supabase-js';

// 2P-PRV2 (#189): admins set how long guest details are kept; guests are told.

const service = () => {
  const { url, serviceRoleKey } = supabaseEnv();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
};

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });
  test.describe.configure({ mode: 'serial' });

  test('AC1: setting 14 days shows 14 days on the join page', async ({ devices }) => {
    const { staff, guest } = devices;
    await staff.goto('/admin/privacy');
    await expect(staff.getByRole('heading', { name: 'Privacy and data retention' })).toBeVisible();
    await expect(
      staff.getByText(/Encrypted backups can hold older data for up to 14 more days/),
    ).toBeVisible();
    const field = staff.getByLabel('Keep contact details for (days)');
    await field.fill('0');
    await expect(staff.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await field.fill('366');
    await expect(staff.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await field.fill('14');
    await expect(staff.getByTestId('retention-impact')).toContainText('After 14 days');
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(staff.getByText('Saved. Contact details are kept 14 days.')).toBeVisible();

    await guest.goto(`/q/${demo.locationSlug}`);
    await guest.getByText('How we use your details').click();
    await expect(guest.getByTestId('retention-notice')).toContainText(
      'keeps your visit details for 14 days.',
    );
    await expect(guest.getByRole('link', { name: 'How your details are used' })).toHaveAttribute(
      'href',
      /queuethat\.com\/privacy/,
    );
  });

  test.afterAll(async () => {
    // Put the demo business back, so other specs and runs see the seeded period.
    await service()
      .schema('app')
      .from('organizations')
      .update({ retention_days: 30 })
      .eq('id', demo.orgId);
  });
});

test('AC2: a manager sees the period read-only', async ({ devices }) => {
  const { guest } = devices;
  const { email } = await createMember(`Manager ${crypto.randomUUID().slice(0, 6)}`, {
    role: 'manager',
  });
  // A stored session, not the sign-in form: its own redirect to /staff races the goto below.
  await signInAs(guest, { email, password: DEMO_PASSWORD });

  await guest.goto('/admin/privacy');
  await expect(guest.getByLabel('Keep contact details for (days)')).toHaveAttribute('readonly', '');
  await expect(guest.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(guest.getByText('Only admins and owners can change this.')).toBeVisible();
});
