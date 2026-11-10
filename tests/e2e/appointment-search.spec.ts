import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';

// A-15 (#288): staff find an appointment weeks ahead by name and jump to its day.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

function dateIn(tz: string, offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

test('AC1: searching a guest name opens the appointment day with it highlighted', async ({
  devices,
}) => {
  const { staff } = devices;
  const tz = 'Europe/Berlin';
  const { slug, serviceId, owner } = await bookableLocation(tz);
  const slot = await firstSlot(slug, serviceId, dateIn(tz, 20), dateIn(tz, 24));
  await bookAsGuest(slug, serviceId, slot, 'Jordan Searchable');
  await signInAs(staff, owner);
  await staff.goto('/admin/appointments');

  await staff.getByLabel('Find an appointment').fill('jordan');
  await expect(staff.getByText(/Jordan Searchable/).first()).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
  await staff.getByRole('button', { name: /^Open day: Jordan Searchable/ }).click();

  await expect(staff.getByLabel('Day', { exact: true })).toHaveValue(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(slot)),
  );
  await expect(staff.locator('li[aria-current="true"]')).toContainText('Jordan Searchable');
});

test('an unmatched search says so', async ({ devices }) => {
  const { staff } = devices;
  const { owner } = await bookableLocation();
  await signInAs(staff, owner);
  await staff.goto('/admin/appointments');
  await staff.getByLabel('Find an appointment').fill('nobody-here');
  await expect(staff.getByText('No appointments match.')).toBeVisible();
});
