import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookableLocation } from './support/booking.ts';

// A-2, A-3, A-5 (#161): booking settings per service, with a preview of what guests get.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const tz = 'Europe/Berlin';
function dateIn(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

async function openBooking(page: import('@playwright/test').Page, as: 'owner' | 'staff') {
  const loc = await bookableLocation(tz);
  const { queueId } = loc;
  await signInAs(page, loc[as]);
  await page.goto(`/admin/queues/${queueId}`);
  await page.getByRole('button', { name: 'Booking' }).click();
  await expect(page.getByTestId('booking-settings')).toBeVisible();
}

test.describe('as owner', () => {
  test('slot length 15 with offset 5 previews :05, :20, :35, :50, and a zero override clears a day', async ({
    devices,
  }) => {
    const { staff } = devices;
    await openBooking(staff, 'owner');
    await expectNoSeriousA11yViolations(staff);

    await staff.getByLabel('Slot length (minutes)').fill('15');
    await staff.getByLabel('Offset (minutes past the hour grid)').fill('5');
    await staff.getByRole('button', { name: 'Save booking settings' }).click();
    await expect(staff.getByText('Saved.')).toBeVisible();

    const day = staff.locator(`[data-day="${dateIn(5)}"]`);
    await expect(day).toContainText(/:05.*:20.*:35.*:50/);

    await staff.getByLabel('Applies to').selectOption('date');
    await staff.getByLabel('Date', { exact: true }).fill(dateIn(5));
    await staff.getByRole('spinbutton', { name: 'Capacity' }).fill('0');
    await staff.getByRole('button', { name: 'Add rule' }).click();
    await expect(day).toContainText('No slots');
    await expectNoSeriousA11yViolations(staff);
  });

  test('a rule for the same day twice is refused politely, and invalid values are explained', async ({
    devices,
  }) => {
    const { staff } = devices;
    await openBooking(staff, 'owner');
    await staff.getByLabel('Slot length (minutes)').fill('3');
    await staff.getByRole('button', { name: 'Save booking settings' }).click();
    await expect(staff.getByText(/5 or more/)).toBeVisible();

    await staff.getByRole('button', { name: 'Add rule' }).click();
    await expect(staff.getByText(/Per slot, Every day: 1/)).toBeVisible();
    await staff.getByRole('button', { name: 'Add rule' }).click();
    await expect(staff.getByText(/already exists/)).toBeVisible();
  });
});

test.describe('as staff', () => {
  test('the fields are read-only', async ({ devices }) => {
    const { staff } = devices;
    await openBooking(staff, 'staff');
    await expect(staff.getByLabel('Slot length (minutes)')).toHaveAttribute('readonly', '');
    await expect(staff.getByRole('button', { name: 'Save booking settings' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(staff);
  });
});
