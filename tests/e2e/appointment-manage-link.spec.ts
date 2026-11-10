import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';

// The link in an appointment email: a one-off manage token (not the booking token) opens the same
// page, "I didn't book this" points at Cancel, and cancelling works from it.
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

// clock-ok: books the first slot of the next three local days, whatever the hour
function dateIn(tz: string, offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

test('a mailed manage link opens the appointment and "I did not book this" cancels it', async ({
  devices,
}) => {
  const { guest } = devices;
  const { slug, serviceId } = await bookableLocation('Europe/Berlin');
  const slot = await firstSlot(
    slug,
    serviceId,
    dateIn('Europe/Berlin', 0),
    dateIn('Europe/Berlin', 3),
  );
  const { token } = await bookAsGuest(slug, serviceId, slot, 'Dana');

  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  let path: string;
  try {
    const [row] = await sql<{ path: string }[]>`
      select private.mint_manage_path(a.id, ${randomUUID()}::uuid) as path
      from app.appointments a where a.guest_token_hash = private.token_hash(${token})`;
    path = row!.path;
  } finally {
    await sql.end();
  }
  expect(path).not.toContain(token);

  await guest.goto(`${path}?cancel=1`);
  await expect(guest.getByTestId('appointment')).toBeVisible();
  await expect(guest.getByText(/Did you not book this/)).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Cancel appointment' }).click();
  await guest.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(guest.getByText('This appointment is cancelled.')).toBeVisible();
});
