import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';

// A-1 (#165): front desk sees the day's appointments, books for a caller and cancels.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

function dateIn(tz: string, offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

async function openAgenda(
  page: import('@playwright/test').Page,
  as: { email: string; password: string },
  day: string,
) {
  await signInAs(page, as);
  await page.goto('/admin/appointments');
  await page.getByLabel('Day').fill(day);
}

test.describe('as owner', () => {
  test('the day buttons step a day at a time, and Today returns', async ({ devices }) => {
    const { staff } = devices;
    const { owner } = await bookableLocation('Europe/Berlin');
    await signInAs(staff, owner);
    await staff.goto('/admin/appointments');
    const day = staff.getByLabel('Day');
    const today = await day.inputValue();
    const shifted = (days: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

    await staff.getByRole('button', { name: 'Next day' }).click();
    await expect(day).toHaveValue(shifted(1));
    await staff.getByRole('button', { name: 'Previous day' }).click();
    await staff.getByRole('button', { name: 'Previous day' }).click();
    await expect(day).toHaveValue(shifted(-1));
    await staff.getByRole('button', { name: 'Today' }).click();
    await expect(day).toHaveValue(today);
    await expectNoSeriousA11yViolations(staff);
  });

  test('a booking is listed and cancelling asks first', async ({ devices }) => {
    const { staff } = devices;
    const tz = 'Europe/Berlin';
    const { slug, serviceId, owner } = await bookableLocation(tz);
    const slot = await firstSlot(slug, serviceId, dateIn(tz, 0), dateIn(tz, 3));
    await bookAsGuest(slug, serviceId, slot, 'Dana Desk');
    await openAgenda(
      staff,
      owner,
      new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(slot)),
    );

    await expect(staff.getByText(/Dana Desk/)).toBeVisible();
    await expectNoSeriousA11yViolations(staff);
    await staff.getByRole('button', { name: /^Cancel Dana Desk/ }).click();
    await expect(staff.getByRole('dialog')).toBeVisible();
    await expect(staff.getByRole('listitem').getByText('Booked', { exact: true })).toBeVisible();
    await staff.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(staff.getByRole('listitem').getByText('Cancelled', { exact: true })).toBeVisible();
  });

  test('booking for a caller takes the slot off the public page', async ({ devices }) => {
    const { staff } = devices;
    const tz = 'Europe/Berlin';
    const { slug, serviceId, owner } = await bookableLocation(tz);
    const before = await firstSlot(slug, serviceId, dateIn(tz, 0), dateIn(tz, 3));
    await openAgenda(staff, owner, dateIn(tz, 0));

    await staff.getByRole('button', { name: 'Book an appointment' }).click();
    await staff.getByRole('dialog').getByRole('list').first().getByRole('button').first().click();
    await staff
      .getByRole('dialog')
      .getByRole('button', { name: /^\d{1,2}:\d{2}/ })
      .first()
      .click();
    await staff.getByLabel('Guest name').fill('Phone Caller');
    await expect(staff.getByLabel('Allow over capacity')).toBeVisible(); // managers see it
    await staff.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(staff.getByRole('dialog')).toBeHidden();

    const after = await firstSlot(slug, serviceId, dateIn(tz, 0), dateIn(tz, 3));
    expect(after).not.toBe(before);
  });
});

test.describe('as staff', () => {
  test('the capacity override is absent', async ({ devices }) => {
    const { staff } = devices;
    const { staff: member } = await bookableLocation('Europe/Berlin');
    await openAgenda(staff, member, dateIn('Europe/Berlin', 0));
    await staff.getByRole('button', { name: 'Book an appointment' }).click();
    await expect(staff.getByLabel('Guest name')).toBeVisible();
    await expect(staff.getByLabel('Allow over capacity')).toHaveCount(0);
  });
});
