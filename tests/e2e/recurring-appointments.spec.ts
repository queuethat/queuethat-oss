import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot, slotsOn } from './support/booking.ts';

// A-11 (#386): staff book a weekly series, see conflicts before confirming, and cancel this and following.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const tz = 'Europe/Berlin';

function dateIn(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}
function localDay(instant: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(instant));
}
function clock(instant: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(instant));
}
function plusDays(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

test('a series lists its conflict before confirm, books the rest and cancels this and following', async ({
  devices,
}) => {
  const { staff } = devices;
  const { slug, serviceId, owner } = await bookableLocation(tz);
  const first = await firstSlot(slug, serviceId, dateIn(0), dateIn(3));
  const day = localDay(first);
  // Someone else already holds the same time one week later.
  const nextWeek = (await slotsOn(slug, serviceId, plusDays(day, 7))).find(
    (s) => clock(s) === clock(first),
  )!;
  await bookAsGuest(slug, serviceId, nextWeek, 'Early Bird');

  await signInAs(staff, owner);
  await staff.goto('/admin/appointments');
  await staff.getByLabel('Day').fill(day);
  await staff.getByRole('button', { name: 'Book an appointment' }).click();
  const dialog = staff.getByRole('dialog');
  await dialog.getByRole('list').first().getByRole('button').first().click();
  await dialog
    .getByRole('button', { name: /^\d{1,2}:\d{2}/ })
    .first()
    .click();
  await dialog.getByLabel('Guest name').fill('Rita Regular');
  await dialog.getByLabel('Repeat').selectOption('weekly');
  await dialog.getByLabel('Number of bookings').fill('3');
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Review dates' }).click();

  // The conflict is listed before anything is booked.
  await expect(dialog.getByRole('list', { name: "Dates that can't be booked" })).toContainText(
    'full',
  );
  await expect(dialog.getByText('2 appointments will be booked', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Book 2 appointments' }).click();
  await expect(dialog).toBeHidden();

  await expect(staff.getByRole('listitem').getByText('Series', { exact: true })).toBeVisible();
  await staff.getByRole('button', { name: /^Cancel this and following/ }).click();
  await expect(staff.getByRole('dialog')).toBeVisible();
  await staff.getByRole('button', { name: 'Keep it' }).click();
  await expect(staff.getByRole('listitem').getByText('Booked', { exact: true })).toBeVisible();
  await staff.getByRole('button', { name: /^Cancel this and following/ }).click();
  await staff
    .getByRole('button', { name: 'Cancel this and following', exact: true })
    .last()
    .click();
  await expect(staff.getByRole('listitem').getByText('Cancelled', { exact: true })).toBeVisible();

  // The later occurrence of the series is cancelled too.
  await staff.getByLabel('Day').fill(plusDays(day, 14));
  await expect(staff.getByRole('listitem').getByText('Cancelled', { exact: true })).toBeVisible();
});
