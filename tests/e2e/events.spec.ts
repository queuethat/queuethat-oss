import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookableLocation } from './support/booking.ts';
import { supabaseEnv } from './support/env.ts';

// A-10 (#279): guests see public events with seats left as a number, book seats, and admins manage and cancel events.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

async function publishedEvent(capacity: number, title: string) {
  const world = await bookableLocation();
  const env = supabaseEnv();
  const service = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: loc, error } = await service
    .schema('app')
    .from('locations')
    .select('org_id')
    .eq('id', world.locationId)
    .single();
  if (error) throw error;
  const start = new Date(Date.now() + 5 * 86_400_000);
  const end = new Date(start.getTime() + 3_600_000);
  const made = await service
    .schema('app')
    .from('events')
    .insert({
      org_id: loc.org_id,
      location_id: world.locationId,
      service_id: world.serviceId,
      title,
      during: `[${start.toISOString()},${end.toISOString()})`,
      capacity,
      public: true,
    });
  if (made.error) throw made.error;
  return world;
}

test('AC1: booking the last seats shows Full to the next visitor', async ({ devices }) => {
  const { guest } = devices;
  const { slug } = await publishedEvent(2, 'Pottery class');
  await guest.goto(`/b/${slug}`);
  await guest.getByRole('tab', { name: 'Events' }).click();
  await expect(guest.getByText('2 seats left')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Book seats for Pottery class' }).click();
  await guest.getByLabel('First name').fill('Ada');
  await guest.getByLabel(/Email/).fill('ada@example.test');
  await guest.getByLabel('Number of seats').fill('2');
  await guest
    .getByRole('button', { name: /^Book|Confirm/ })
    .last()
    .click();
  await expect(guest).toHaveURL(/\/a\//);
  // The URL matches before WebKit has committed the app's own navigation to /a/, and a goto sent
  // in that gap is aborted ("interrupted by another navigation"). The booking card only renders
  // once that navigation has finished and the appointment has loaded.
  await expect(guest.getByTestId('appointment')).toBeVisible();

  await guest.goto(`/b/${slug}`);
  await guest.getByRole('tab', { name: 'Events' }).click();
  await expect(guest.getByText('Full', { exact: true })).toBeVisible();
});

test('admins see attendees and cancel an event after confirming', async ({ devices }) => {
  const { guest, staff } = devices;
  const { slug, owner } = await publishedEvent(5, 'Shop tour');
  await guest.goto(`/b/${slug}`);
  await guest.getByRole('tab', { name: 'Events' }).click();
  await guest.getByRole('button', { name: 'Book seats for Shop tour' }).click();
  await guest.getByLabel('First name').fill('Bea');
  await guest.getByLabel(/Email/).fill('bea@example.test');
  await guest
    .getByRole('button', { name: /^Book|Confirm/ })
    .last()
    .click();
  await expect(guest).toHaveURL(/\/a\//);

  await signInAs(staff, owner);
  await staff.goto('/admin/events');
  await expect(staff.getByText('1 of 5 seats taken')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: 'Attendees of Shop tour' }).click();
  await expect(staff.getByText('Bea · 1 seat')).toBeVisible();
  await staff.getByRole('button', { name: 'Cancel event Shop tour' }).click();
  await expect(staff.getByRole('dialog')).toBeVisible();
  await staff.getByRole('button', { name: 'Cancel event', exact: true }).click();
  await expect(staff.getByText('Cancelled', { exact: true }).first()).toBeVisible();
});
