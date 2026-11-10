import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-A10 (#285): managers see who is booked, blocked or on shift across the day.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
const tz = 'Europe/Berlin';

/** "9:00" for the 12-hour display of `instant` in Berlin (the grid prints "9:00 AM"). */
function clock(instant: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = parts.find((p) => p.type === 'minute')!.value;
  return `${h % 12 || 12}:${m}`;
}

test('AC1, AC2, AC3: rows, times in the location tz, table fallback, location scope', async ({
  devices,
}) => {
  const { staff } = devices;
  const shop = await bookableLocation(tz);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
    new Date(Date.now() + 86_400_000),
  );
  const slot = await firstSlot(shop.slug, shop.serviceId, day, day);
  await bookAsGuest(shop.slug, shop.serviceId, slot, 'Grid Guest');

  const base = { org_id: shop.orgId, location_id: shop.locationId };
  const chairs = await service
    .schema('app')
    .from('counters')
    .insert([
      { ...base, label: 'Chair A' },
      { ...base, label: 'Chair B' },
    ])
    .select('id, label');
  if (chairs.error) throw chairs.error;
  const chairA = chairs.data.find((c) => c.label === 'Chair A')!.id;
  const chairB = chairs.data.find((c) => c.label === 'Chair B')!.id;
  // The service is done in Chair A. Chair B has a shift and a block.
  await service
    .schema('app')
    .from('service_resources')
    .insert({ ...base, service_id: shop.serviceId, counter_id: chairA });
  const start = new Date(slot);
  const end = new Date(start.getTime() + 3_600_000);
  const member = await service
    .schema('app')
    .from('memberships')
    .select('user_id')
    .eq('org_id', shop.orgId)
    .eq('role', 'staff')
    .single();
  if (member.error) throw member.error;
  const shift = await service
    .schema('app')
    .from('staff_shifts')
    .insert({
      ...base,
      user_id: member.data.user_id,
      counter_id: chairB,
      during: `[${start.toISOString()},${new Date(start.getTime() + 4 * 3_600_000).toISOString()})`,
    });
  if (shift.error) throw shift.error;
  const owner = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  await owner.auth.signInWithPassword(shop.owner);
  const blocked = await owner.schema('api').rpc('block_time_bulk', {
    p_location_id: shop.locationId,
    p_resource_ids: [chairB],
    p_ranges: [`[${start.toISOString()},${end.toISOString()})`],
    p_reason: 'Training',
    p_idempotency_key: randomUUID(),
  });
  if (blocked.error) throw blocked.error;

  // A second site of the org with its own resource; the staff member only works at the first.
  const other = await service
    .schema('app')
    .from('locations')
    .insert({ org_id: shop.orgId, name: 'Elsewhere', slug: `else-${randomUUID().slice(0, 8)}`, tz })
    .select('id')
    .single();
  if (other.error) throw other.error;
  await service
    .schema('app')
    .from('counters')
    .insert({ org_id: shop.orgId, location_id: other.data.id, label: 'Elsewhere chair' });
  await service
    .schema('app')
    .from('memberships')
    .update({ location_ids: [shop.locationId] })
    .eq('org_id', shop.orgId)
    .eq('role', 'staff');

  await signInAs(staff, shop.staff);
  await staff.goto('/staff/planning');
  await staff.getByLabel('Date').fill(day);
  await expect(staff.getByRole('heading', { name: 'Planning' })).toBeVisible();
  await expect(staff.getByText('Chair A')).toBeVisible();
  await expect(staff.getByText('Chair B')).toBeVisible();
  await expect(staff.getByText('Elsewhere chair')).toHaveCount(0); // AC3

  // AC1 through the table, which carries the same data as the grid.
  await staff.getByRole('button', { name: 'Show as table' }).click();
  const rowA = staff.getByRole('row').filter({ hasText: 'Chair A' });
  await expect(rowA).toContainText('Grid Guest');
  await expect(rowA).toContainText(clock(slot));
  const rowB = staff.getByRole('row').filter({ hasText: 'Chair B' });
  await expect(rowB.filter({ hasText: 'Training' })).toContainText(clock(slot));
  await expect(rowB.filter({ hasText: 'Shift' })).toHaveCount(1);
  await expectNoSeriousA11yViolations(staff); // AC2

  await staff.getByRole('button', { name: 'Show as grid' }).click();
  await expect(staff.getByTitle(/Grid Guest/)).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});
