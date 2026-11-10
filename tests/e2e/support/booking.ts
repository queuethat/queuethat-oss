import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { confirmedAccount, NEW_ACCOUNT_PASSWORD, restAs } from './accounts.ts';
import { supabaseEnv } from './env.ts';
import { uniqueEmail } from './mail.ts';

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(env.url, env.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export type Account = { email: string; password: string };

/**
 * A business of its own (an org, its owner, one staff member and a location with one bookable
 * service: hourly slots, 08:00 to 20:00 every day, one seat), so specs that book never touch the
 * demo org. Appointments cannot be deleted, so sharing the demo org would leave locations behind
 * that turn the location label into a picker for every spec that runs after. Sign a page in as
 * `owner` or `staff` with `signInAs`.
 */
export async function bookableLocation(tz = 'Europe/Berlin', capacity = 1) {
  const tag = `book-${randomUUID().slice(0, 8)}`;
  const owner: Account = { email: await confirmedAccount(), password: NEW_ACCOUNT_PASSWORD };
  const made = await restAs(owner.email, 'rpc/create_organization', {
    method: 'POST',
    headers: { 'content-profile': 'api' },
    body: JSON.stringify({ p_name: `Book ${tag}`, p_location_name: `Book ${tag}`, p_tz: tz }),
  });
  if (!made.ok) throw new Error(await made.text());
  const location = check(
    await service
      .schema('app')
      .from('locations')
      .select('id, org_id, slug')
      .eq('name', `Book ${tag}`)
      .single(),
  );
  const orgId = location!.org_id as string;
  const locationId = location!.id as string;
  const locationSlug = location!.slug as string;
  const staff: Account = { email: uniqueEmail('staff'), password: NEW_ACCOUNT_PASSWORD };
  const created = await service.auth.admin.createUser({
    email: staff.email,
    password: staff.password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  check(
    await service
      .schema('app')
      .from('memberships')
      .insert({ org_id: orgId, user_id: created.data.user.id, role: 'staff' }),
  );
  const queue = check(
    await service
      .schema('app')
      .from('queues')
      .insert({
        org_id: orgId,
        location_id: locationId,
        name: 'Appointments',
        ticket_prefix: 'APT',
      })
      .select('id')
      .single(),
  );
  const base = { org_id: orgId, location_id: locationId };
  const svc = check(
    await service
      .schema('app')
      .from('services')
      .insert({ ...base, queue_id: queue!.id, name: 'Consultation', expected_minutes: 30 })
      .select('id')
      .single(),
  );
  const serviceId = svc!.id as string;
  const days = [0, 1, 2, 3, 4, 5, 6];
  // The hours trigger needs a signed-in role; the service role cannot run private helpers.
  const ownerClient = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const signedIn = await ownerClient.auth.signInWithPassword(owner);
  if (signedIn.error) throw signedIn.error;
  check(
    await ownerClient
      .schema('app')
      .from('business_hours')
      .insert(days.map((weekday) => ({ ...base, weekday, opens: '08:00', closes: '20:00' }))),
  );
  check(
    await service
      .schema('app')
      .from('availability_rules')
      .insert(days.map((weekday) => ({ ...base, weekday, starts: '08:00', ends: '20:00' }))),
  );
  check(
    await service
      .schema('app')
      .from('booking_policies')
      .insert({
        ...base,
        service_id: serviceId,
        bookable: true,
        slot_minutes: 60,
        min_notice_minutes: 0,
      }),
  );
  if (capacity !== 1)
    check(
      await service
        .schema('app')
        .from('capacity_rules')
        .insert({ ...base, service_id: serviceId, scope: 'slot', capacity }),
    );
  return {
    slug: locationSlug,
    orgId,
    locationId,
    serviceId,
    queueId: queue!.id as string,
    owner,
    staff,
  };
}

/** The earliest open slot, as the public RPC lists it. */
export async function firstSlot(slug: string, serviceId: string, from: string, to: string) {
  const slots = check(
    await anon.schema('api').rpc('get_available_slots', {
      p_location_slug: slug,
      p_service_id: serviceId,
      p_from: from,
      p_to: to,
    }),
  ) as { slot_start: string }[];
  return slots[0]!.slot_start;
}

/** Books as another guest would, straight through the public RPC. */
export async function bookAsGuest(
  slug: string,
  serviceId: string,
  slotStart: string,
  name = 'Other',
) {
  return check(
    await anon.schema('api').rpc('book_appointment', {
      p_location_slug: slug,
      p_service_id: serviceId,
      p_slot_start: slotStart,
      p_name: name,
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
    }),
  ) as { token: string; starts_at: string };
}

/** Every slot of a service on one local date, as the public RPC lists them. */
export async function slotsOn(slug: string, serviceId: string, date: string) {
  const slots = check(
    await anon.schema('api').rpc('get_available_slots', {
      p_location_slug: slug,
      p_service_id: serviceId,
      p_from: date,
      p_to: date,
    }),
  ) as { slot_start: string }[];
  return slots.map((s) => s.slot_start);
}

/** Drops the helper's all-week availability, so a spec can set its own hours through the UI. */
export async function clearAvailability(locationId: string) {
  check(
    await service.schema('app').from('availability_rules').delete().eq('location_id', locationId),
  );
}
