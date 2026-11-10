import { createClient } from '@supabase/supabase-js';
import { bookableLocation } from './support/booking.ts';
import { supabaseEnv } from './support/env.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// M5 (#1292): a location with provider lines offers "Anyone available" and each person before the
// service; ?for=<line> picks one from a link. The database decides what each line says.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up lines');

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function linedLocation() {
  const place = await bookableLocation();
  const base = { org_id: place.orgId, location_id: place.locationId };
  // Always open: this test is about the picker, not hours.
  const hours = await service.schema('app').from('business_hours').delete().match(base);
  if (hours.error) throw hours.error;
  const lines = await service
    .schema('app')
    .from('queues')
    .insert([
      { ...base, name: 'Anyone', ticket_prefix: 'P', kind: 'pool', sort_order: 9 },
      { ...base, name: 'Ana', ticket_prefix: 'A', kind: 'provider', sort_order: 1 },
      { ...base, name: 'Ben', ticket_prefix: 'B', kind: 'provider', sort_order: 2 },
    ])
    .select('id, name');
  if (lines.error) throw lines.error;
  const id = (name: string) => lines.data.find((l) => l.name === name)!.id as string;
  const services = await service
    .schema('app')
    .from('services')
    .insert([
      { ...base, queue_id: id('Ana'), name: 'Haircut', expected_minutes: 20 },
      { ...base, queue_id: id('Ana'), name: 'Colour', expected_minutes: 60 },
      { ...base, queue_id: id('Ben'), name: 'Beard', expected_minutes: 15 },
      { ...base, queue_id: id('Anyone'), name: 'Haircut', expected_minutes: 20 },
    ]);
  if (services.error) throw services.error;
  return { slug: place.slug, ana: id('Ana'), pool: id('Anyone') };
}

test('the guest picks Anyone available or a person, then the service, and joins', async ({
  devices,
}) => {
  const { guest } = devices;
  const place = await linedLocation();
  await guest.goto(`/q/${place.slug}`);

  const anyone = guest.getByRole('radio', { name: /Anyone available/ });
  await expect(anyone).toBeChecked();
  await expect(guest.getByRole('radio')).toHaveCount(4); // Anyone, Ana, Ben, and the "Appointments" queue
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('radio', { name: /Ana/ }).check();
  await expect(guest.getByLabel('What do you need?')).toContainText('Colour');
  await guest.getByLabel('What do you need?').selectOption({ label: 'Colour' });
  await guest.getByLabel('First name').fill('Dana');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expect(guest.getByText(/A\d{3}/).first()).toBeVisible();
});

test('?for=<line> opens the page on that line; a stranger id changes nothing', async ({
  devices,
}) => {
  const { guest } = devices;
  const place = await linedLocation();

  await guest.goto(`/q/${place.slug}?for=${place.ana}`);
  await expect(guest.getByRole('radio', { name: /Ana/ })).toBeChecked();

  await guest.goto(`/q/${place.slug}?for=00000000-0000-4000-8000-000000000000`);
  await expect(guest.getByRole('radio', { name: /Anyone available/ })).toBeChecked();
});

test('Spanish guests see the picker in Spanish', async ({ browser }) => {
  const place = await linedLocation();
  const context = await browser.newContext({ locale: 'es-MX' });
  const guest = await context.newPage();
  await guest.goto(`/q/${place.slug}`);
  await expect(guest.getByRole('radio', { name: /Cualquiera disponible/ })).toBeChecked();
  await context.close();
});
