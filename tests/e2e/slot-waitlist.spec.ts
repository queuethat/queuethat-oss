import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { bookAsGuest, bookableLocation, firstSlot } from './support/booking.ts';
import { supabaseEnv } from './support/env.ts';
import { uniqueEmail } from './support/mail.ts';

// A-13 (#277): a full slot opens, the first guest on the waitlist is offered it and claims it.
test.use({ staffUser: null });
test.skip(process.env.E2E_PILOT === '1', 'needs the service role to set up a bookable location');

const env = supabaseEnv();
const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } });

function dateIn(tz: string, offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

test('AC1: an offered guest sees the held time and claims it', async ({ devices }) => {
  const { guest } = devices;
  const tz = 'Europe/Berlin';
  const { slug, serviceId } = await bookableLocation(tz);
  const day = dateIn(tz, 5);
  const slot = await firstSlot(slug, serviceId, day, day);
  const holder = await bookAsGuest(slug, serviceId, slot, 'Holder');

  const joined = await anon.schema('api').rpc('guest_join_waitlist', {
    p_location_slug: slug,
    p_service_id: serviceId,
    p_wanted_day: day,
    p_window_start: null,
    p_window_end: null,
    p_name: 'Waiting Wes',
    p_phone_e164: null,
    p_email: uniqueEmail('wait'),
    p_idempotency_key: randomUUID(),
  });
  expect(joined.error).toBeNull();
  const token = joined.data as unknown as string;

  await guest.goto(`/o/${token}`);
  await expect(guest.getByText(/waitlist/i).first()).toBeVisible();

  const cancelled = await anon.schema('api').rpc('guest_cancel_appointment', {
    p_token: holder.token,
    p_idempotency_key: randomUUID(),
  });
  expect(cancelled.error).toBeNull();

  await guest.reload();
  await expect(guest.getByTestId('offer-when')).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Book this time' }).click();
  await expect(guest).toHaveURL(/\/a\//);
});
