import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { bookableLocation, clearAvailability, slotsOn } from './support/booking.ts';

// A-4 (#162): managers set weekly hours and exceptions, and that drives which slots exist.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');
test.use({ staffUser: null });

const tz = 'Europe/Berlin';

/** The next Monday at least a week out, as a Berlin date. */
function nextMonday() {
  const d = new Date(Date.now() + 7 * 86_400_000);
  while (new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d) !== 'Mon')
    d.setUTCDate(d.getUTCDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

const hourOf = (iso: string) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(
      new Date(iso),
    ),
  );

async function open(page: import('@playwright/test').Page) {
  const loc = await bookableLocation(tz);
  await clearAvailability(loc.locationId);
  await signInAs(page, loc.owner);
  await page.goto('/admin/availability');
  await expect(page.getByRole('heading', { name: 'Staff availability' })).toBeVisible();
  return loc;
}

test('Monday 09:00-13:00 limits the slots, added with the keyboard alone', async ({ devices }) => {
  const { staff } = devices;
  const { slug, serviceId } = await open(staff);
  await expect(staff.getByText(/Times are in Central European/)).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  // No pointer: focus, type, submit with Enter. Monday is the form's default day.
  await staff.getByLabel('From').first().focus();
  await staff.keyboard.press('Control+A');
  await staff.getByLabel('From').first().fill('09:00');
  await staff.getByLabel('To').first().focus();
  await staff.getByLabel('To').first().fill('13:00');
  await staff.keyboard.press('Enter');
  await expect(staff.getByTestId('range')).toContainText('09:00–13:00');

  const hours = (await slotsOn(slug, serviceId, nextMonday())).map(hourOf);
  expect(hours.length).toBeGreaterThan(0);
  expect(Math.min(...hours)).toBe(9);
  expect(Math.max(...hours)).toBeLessThan(13);
});

test('overlapping hours are refused, and an unavailable day offers no slots', async ({
  devices,
}) => {
  const { staff } = devices;
  const { slug, serviceId } = await open(staff);
  const add = async (from: string, to: string) => {
    await staff.getByLabel('From').first().fill(from);
    await staff.getByLabel('To').first().fill(to);
    await staff.getByRole('button', { name: 'Add hours' }).click();
  };
  await staff.getByLabel('Day', { exact: true }).selectOption('1');
  await add('09:00', '13:00');
  await expect(staff.getByTestId('range')).toHaveCount(1);
  await add('12:00', '15:00');
  await expect(staff.getByText(/overlap hours already set/)).toBeVisible();
  await expect(staff.getByTestId('range')).toHaveCount(1);

  const monday = nextMonday();
  expect((await slotsOn(slug, serviceId, monday)).length).toBeGreaterThan(0);
  await staff.getByLabel('Date', { exact: true }).fill(monday);
  await staff.getByRole('button', { name: 'Add exception' }).click();
  await expect(staff.getByTestId('exception')).toContainText(monday);
  expect(await slotsOn(slug, serviceId, monday)).toHaveLength(0);
});
