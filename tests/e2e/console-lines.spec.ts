import { createClient } from '@supabase/supabase-js';
import { restAs } from './support/accounts.ts';
import { bookableLocation } from './support/booking.ts';
import { guestJoins } from './support/console.ts';
import { supabaseEnv } from './support/env.ts';
import {
  expect,
  expectNoSeriousA11yViolations,
  LIVE_TIMEOUT_MS,
  signInAs,
  test,
} from './fixtures.ts';

// M6 (#1293): a provider opens on their own line plus "Anyone available"; the front desk sees every
// line on one screen; Call next on a provider line falls back to the pool (M4, in the database).
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up lines'); // #32
test.use({ staffUser: null });

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('app');

/** A business of its own with Ana's and Ben's lines pulling from a pool; its staff member is Ana. */
async function linedShop({ scoped }: { scoped: boolean }) {
  const shop = await bookableLocation();
  const base = { org_id: shop.orgId, location_id: shop.locationId };
  // Always open: this is about the lines, not hours.
  const hours = await service.from('business_hours').delete().match(base);
  if (hours.error) throw hours.error;
  const pool = await service
    .from('queues')
    .insert({ ...base, name: 'Anyone', ticket_prefix: 'P', kind: 'pool', sort_order: 9 })
    .select('id')
    .single();
  if (pool.error) throw pool.error;
  const lines = await service
    .from('queues')
    .insert([
      {
        ...base,
        name: 'Ana',
        ticket_prefix: 'A',
        kind: 'provider',
        pulls_from: pool.data.id,
        sort_order: 1,
      },
      {
        ...base,
        name: 'Ben',
        ticket_prefix: 'B',
        kind: 'provider',
        pulls_from: pool.data.id,
        sort_order: 2,
      },
    ])
    .select('id, name');
  if (lines.error) throw lines.error;
  const id = (name: string) => lines.data.find((l) => l.name === name)!.id as string;
  const user = await service
    .from('memberships')
    .select('id, user_id')
    .eq('org_id', shop.orgId)
    .eq('role', 'staff')
    .single();
  if (user.error) throw user.error;
  const member = await service
    .from('memberships')
    .update({ queue_ids: [id('Ana')] })
    .eq('id', user.data.id);
  if (member.error) throw member.error;
  if (scoped) {
    // Only an admin may switch the setting; the service role has no column grant for it.
    const org = await restAs(shop.owner.email, `organizations?id=eq.${shop.orgId}`, {
      method: 'PATCH',
      body: JSON.stringify({ scope_staff_to_lines: true }),
    });
    if (!org.ok) throw new Error(await org.text());
  }
  return { ...shop, ana: id('Ana'), ben: id('Ben'), pool: pool.data.id as string };
}

for (const scoped of [false, true]) {
  test(`a provider starts on their line and the pool, and Call next takes from the pool (${
    scoped ? 'scoped' : 'unscoped'
  })`, async ({ devices }) => {
    const { staff } = devices;
    const shop = await linedShop({ scoped });
    await guestJoins('Pat', shop.pool);
    await guestJoins('Bo', shop.ben);

    await signInAs(staff, shop.staff);
    await staff.goto('/staff');
    await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
    // Lines are tabs only: a provider sees their line and the pool.
    const tabs = staff.getByRole('tab');
    await expect(tabs).toHaveText([/Ana/, /Anyone/]);
    // Unscoped, the provider may look at every line; scoped, only their own.
    await expect(staff.getByRole('button', { name: 'All lines', exact: true })).toHaveCount(
      scoped ? 0 : 1,
    );
    // The main panel opens on Ana's line, whose one Call next reaches the pool.
    await expect(staff.getByRole('tab', { name: /Ana/, selected: true })).toBeVisible();
    await expect(staff.getByText('Next comes from Anyone.')).toBeVisible();
    await expect(staff.getByRole('button', { name: 'Call next' })).toHaveCount(1);
    await expectNoSeriousA11yViolations(staff);

    await staff.getByRole('button', { name: 'Call next' }).click();
    await expect(staff.getByText(/Called P\d{3}/)).toBeVisible();
    await expect(staff.getByRole('button', { name: 'Call next' })).toBeDisabled();
  });
}

test('the front desk sees every line on one screen', async ({ devices }) => {
  const { staff } = devices;
  const shop = await linedShop({ scoped: true });
  await guestJoins('Bo', shop.ben);
  await signInAs(staff, shop.owner);
  await staff.goto('/staff');
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await expect(staff.getByRole('tab')).toHaveText([/Appointments/, /Ana/, /Ben/, /Anyone/]);
  await expect(staff.getByRole('tab', { name: /Ben/ })).toContainText('1');
  await staff.getByRole('tab', { name: /Ben/ }).click();
  await expect(staff.getByRole('tab', { name: /Ben/, selected: true })).toBeVisible();
  await expect(staff).toHaveURL(new RegExp(`queue=${shop.ben}`));
  await expect(staff.getByTestId('section-waiting')).toContainText('B001');
});

// #80: with the barber template the console opened on an empty provider line and said "No one is
// waiting" while guests waited in the pool, and the guest Call next took from the pool vanished.
test('a provider line lists the pool it calls from, and keeps the called guest in view', async ({
  devices,
}) => {
  const { staff } = devices;
  const shop = await linedShop({ scoped: false });
  const other = await linedShop({ scoped: false });
  await guestJoins('Pat', shop.pool);
  await guestJoins('Sky', shop.pool);
  await guestJoins('Elsewhere', other.pool);

  await signInAs(staff, shop.staff);
  await staff.goto('/staff');
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await expect(staff.getByRole('tab', { name: /Ana/, selected: true })).toBeVisible();
  const waiting = staff.getByTestId('section-waiting');
  await expect(waiting).toContainText('Pat');
  await expect(waiting).toContainText('Sky');
  await expect(waiting.getByTestId('line-badge').first()).toHaveText('In Anyone');
  await expect(staff.getByText('No one is waiting')).toHaveCount(0);
  // Another business's pool never shows (cross-tenant).
  await expect(staff.getByText('Elsewhere')).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('button', { name: 'Call next' }).click();
  await expect(staff.getByText(/Called P\d{3}/)).toBeVisible();
  // The called guest stays on Ana's tab, pinned above the line.
  await expect(staff.getByTestId('section-called')).toContainText('Pat');
  await expect(waiting).toContainText('Sky');
});

// #87: one confirmed step closes every line at the location, through the per-line RPC. Staff may
// close a line (api.set_queue_state needs staff), so they may close them all too.
test('Close all lines for today closes every line here and no other business’s', async ({
  devices,
}) => {
  const { staff } = devices;
  const shop = await linedShop({ scoped: false });
  const other = await linedShop({ scoped: false });
  const bo = await guestJoins('Bo', shop.ben);

  await signInAs(staff, shop.staff);
  await staff.goto('/staff');
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  const controls = staff.getByTestId('queue-controls');
  // Per-line close stays beside it.
  await expect(controls.getByRole('button', { name: 'Close queue' })).toBeVisible();
  await controls.getByRole('button', { name: 'Close all lines for today' }).click();
  const dialog = staff.getByRole('dialog', { name: /^Close all \d+ lines\?$/ });
  for (const name of ['Ana', 'Ben', 'Anyone']) await expect(dialog).toContainText(name);
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Yes, close them all' }).click();
  await expect(dialog).toBeHidden();
  await expect(controls).toContainText('Closed: no new guests');
  await expect(controls.getByRole('button', { name: 'Close all lines for today' })).toHaveCount(0);

  const states = async (locationId: string) => {
    const { data, error } = await service
      .from('queues')
      .select('manual_state')
      .eq('location_id', locationId)
      .is('archived_at', null);
    if (error) throw error;
    return data.map((q) => q.manual_state as string);
  };
  await expect.poll(() => states(shop.locationId)).not.toContain('open');
  expect(await states(other.locationId)).toContain('open');
  // Bo keeps his place.
  const status = await service.schema('api').rpc('get_visit_status', { p_token: bo.token });
  if (status.error) throw status.error;
  expect((status.data as { status: string }).status).toBe('waiting');
});
