import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// A-1 (#163): a guest books a slot from the public page and lands on their appointment.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

function dateIn(tz: string, offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

test('a double tap on Confirm books exactly one appointment, shown in the location clock', async ({
  devices,
}) => {
  const { guest } = devices;
  const { slug } = await bookableLocation('Europe/Berlin');
  const booked: string[] = [];
  guest.on('response', async (response) => {
    if (!response.url().endsWith('/rpc/book_appointment') || !response.ok()) return;
    booked.push(((await response.json()) as { token: string }).token);
  });

  await guest.goto(`/b/${slug}`);
  await expect(guest.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
  await expect(guest.getByText(/Times are in Central European/)).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('list').first().getByRole('button').first().click();
  await guest
    .getByRole('button', { name: /^\d{1,2}:\d{2}/ })
    .first()
    .click();
  await guest.getByLabel('First name').fill('Dana');
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Confirm booking' }).dblclick();

  await expect(guest).toHaveURL(/\/a\/[\w-]+$/);
  await expect(guest.getByTestId('appointment')).toContainText('Consultation');
  await expect(guest.getByTestId('appointment')).toContainText('Central European');
  expect(new Set(booked).size).toBe(1);
});

test('a slot taken by someone else shows a friendly message and fresh times', async ({
  devices,
}) => {
  const { guest } = devices;
  const { slug, serviceId } = await bookableLocation('Europe/Berlin');

  await guest.goto(`/b/${slug}`);
  await guest.getByRole('list').first().getByRole('button').first().click();
  await guest
    .getByRole('button', { name: /^\d{1,2}:\d{2}/ })
    .first()
    .click();
  await guest.getByLabel('First name').fill('Dana');
  // Another guest takes the earliest slot while this one types.
  const earliest = await firstSlot(
    slug,
    serviceId,
    dateIn('Europe/Berlin', 0),
    dateIn('Europe/Berlin', 3),
  );
  await bookAsGuest(slug, serviceId, earliest);
  await guest.getByRole('button', { name: 'Confirm booking' }).click();

  await expect(guest.getByRole('alert')).toContainText('just taken');
  await expect(guest).toHaveURL(/\/b\//);
  await expect(guest.getByRole('heading', { name: /Pick a day/ })).toBeVisible();
});

test('a location with nothing bookable says so', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto('/b/demo-barber');
  await expect(guest.getByText('No times available')).toBeVisible();
});
