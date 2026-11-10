import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';

// A-6 (#164): a guest moves or cancels their appointment from the link.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

function dateIn(tz: string, offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

async function booked() {
  const { slug, serviceId } = await bookableLocation('Europe/Berlin');
  const slot = await firstSlot(
    slug,
    serviceId,
    dateIn('Europe/Berlin', 0),
    dateIn('Europe/Berlin', 3),
  );
  const { token } = await bookAsGuest(slug, serviceId, slot, 'Dana');
  return { token, slug };
}

test('rescheduling shows the new time', async ({ devices }) => {
  const { guest } = devices;
  const { token } = await booked();
  await guest.goto(`/a/${token}`);
  const before = await guest.getByTestId('appointment-when').textContent();
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Change time' }).click();
  await guest.getByRole('list').first().getByRole('button').first().click();
  // The last time of the first day differs from the booked (earliest) one.
  await guest.getByRole('list').last().getByRole('button').last().click();
  await guest.getByRole('button', { name: /^Move to/ }).click();

  await expect(guest.getByRole('button', { name: 'Change time' })).toBeVisible();
  await expect(guest.getByTestId('appointment-when')).not.toHaveText(before!);
});

test('cancel does nothing until it is confirmed', async ({ devices }) => {
  const { guest } = devices;
  const { token } = await booked();
  await guest.goto(`/a/${token}`);

  await guest.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(guest.getByRole('dialog')).toBeVisible();
  await expect(guest.getByText('Booked', { exact: true })).toBeVisible();
  await guest.getByRole('button', { name: 'Keep it' }).click();
  await expect(guest.getByText('Booked', { exact: true })).toBeVisible();

  await guest.getByRole('button', { name: 'Cancel appointment' }).click();
  await guest.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(guest.getByText('This appointment is cancelled.')).toBeVisible();
});

test('an unknown link reads as not found', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto('/a/does-not-exist-0123456789');
  await expect(guest.getByText('Appointment not found')).toBeVisible();
});
