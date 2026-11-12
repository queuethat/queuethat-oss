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
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up lines');
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
    const board = staff.getByRole('region', { name: 'Lines' });
    await expect(board.getByRole('heading', { level: 3 })).toHaveText(['Ana', 'Anyone']);
    // Unscoped, the provider may look at every line; scoped, only their own.
    await expect(board.getByRole('button', { name: 'All lines' })).toHaveCount(scoped ? 0 : 1);
    // The main panel opens on Ana's line, whose Call next reaches the pool.
    await expect(staff.getByRole('tab', { name: /Ana/, selected: true })).toBeVisible();
    await expect(board.getByTestId(`line-${shop.ana}`)).toContainText('Next comes from Anyone.');
    await expectNoSeriousA11yViolations(staff);

    await board.getByRole('button', { name: 'Call next for Ana' }).click();
    await expect(staff.getByText(/Called P\d{3}/)).toBeVisible();
    await expect(board.getByTestId(`line-${shop.pool}`)).toContainText('0 waiting');
    await expect(board.getByRole('button', { name: 'Call next for Ana' })).toBeDisabled();
  });
}

test('the front desk sees every line on one screen', async ({ devices }) => {
  const { staff } = devices;
  const shop = await linedShop({ scoped: true });
  await guestJoins('Bo', shop.ben);
  await signInAs(staff, shop.owner);
  await staff.goto('/staff');
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  const board = staff.getByRole('region', { name: 'Lines' });
  await expect(board.getByRole('heading', { level: 3 })).toHaveText([
    'Appointments',
    'Ana',
    'Ben',
    'Anyone',
  ]);
  await expect(board.getByTestId(`line-${shop.ben}`)).toContainText('B001');
  await board.getByRole('button', { name: 'Open Ben' }).click();
  await expect(staff.getByRole('tab', { name: /Ben/, selected: true })).toBeVisible();
  await expect(staff).toHaveURL(new RegExp(`queue=${shop.ben}`));
});
