import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookableLocation, slotsOn } from './support/booking.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-A11 (#286): managers block many cells in one gesture, by pointer or keyboard.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
const tz = 'Europe/Berlin';
const COL_10_00 = (10 * 60 - 7 * 60) / 15; // the grid starts at 07:00
const COL_11_45 = (11 * 60 + 45 - 7 * 60) / 15; // last 15-minute cell of the 10:00-12:00 range

/** A shop with three chairs that all do its one service, and tomorrow's date there. */
async function shopWithChairs() {
  const shop = await bookableLocation(tz);
  const base = { org_id: shop.orgId, location_id: shop.locationId };
  const chairs = await service
    .schema('app')
    .from('counters')
    .insert(['Chair A', 'Chair B', 'Chair C'].map((label) => ({ ...base, label })))
    .select('id');
  if (chairs.error) throw chairs.error;
  const mapped = await service
    .schema('app')
    .from('service_resources')
    .insert(chairs.data.map((c) => ({ ...base, service_id: shop.serviceId, counter_id: c.id })));
  if (mapped.error) throw mapped.error;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
    new Date(Date.now() + 86_400_000),
  );
  return { shop, day };
}

async function blockCount(locationId: string) {
  const { count, error } = await service
    .schema('app')
    .from('time_blocks')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId);
  if (error) throw error;
  return count;
}

const localHours = (slots: string[]) =>
  slots.map((s) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(s),
    ),
  );

test('AC1: dragging over 3 chairs x 2 hours blocks them and the booking page hides the slots', async ({
  devices,
}) => {
  const { staff } = devices;
  const { shop, day } = await shopWithChairs();
  expect(localHours(await slotsOn(shop.slug, shop.serviceId, day))).toEqual(
    expect.arrayContaining(['10', '11']),
  );

  await signInAs(staff, shop.owner);
  await staff.goto('/staff/planning');
  await staff.getByLabel('Date').fill(day);
  const cell = (row: number, col: number) => staff.locator(`[data-cell="${row}-${col}"]`);
  const from = (await cell(0, COL_10_00).boundingBox())!;
  const to = (await cell(2, COL_11_45).boundingBox())!;
  await staff.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await staff.mouse.down();
  await staff.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await staff.mouse.up();

  const dialog = staff.getByRole('dialog', { name: 'Block time' });
  await expect(dialog).toContainText('3 resources');
  await dialog.getByLabel('Reason (optional)').fill('Team meeting');
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Block time' }).click();

  await expect(staff.getByText('Blocked 3 slots.')).toBeVisible();
  await expect.poll(() => blockCount(shop.locationId)).toBe(3);
  const hours = localHours(await slotsOn(shop.slug, shop.serviceId, day));
  expect(hours).not.toContain('10');
  expect(hours).not.toContain('11');
  expect(hours).toContain('09');

  // The toast undoes it.
  await staff.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => blockCount(shop.locationId)).toBe(0);
});

test('AC2: the same blocks can be made with the keyboard alone', async ({ devices }) => {
  const { staff } = devices;
  const { shop, day } = await shopWithChairs();
  await signInAs(staff, shop.owner);
  await staff.goto('/staff/planning');
  await staff.getByLabel('Date').fill(day);

  await staff.getByRole('region', { name: /Planning grid/ }).focus();
  for (let i = 0; i < COL_10_00; i++) await staff.keyboard.press('ArrowRight');
  await staff.keyboard.press('Shift+ArrowDown');
  await staff.keyboard.press('Shift+ArrowDown');
  for (let i = 0; i < COL_11_45 - COL_10_00; i++) await staff.keyboard.press('Shift+ArrowRight');
  await staff.keyboard.press('Enter');

  const dialog = staff.getByRole('dialog', { name: 'Block time' });
  await expect(dialog).toContainText('3 resources');
  await dialog.getByRole('button', { name: 'Block time' }).click();
  await expect.poll(() => blockCount(shop.locationId)).toBe(3);
});
