// 2P-APT3 (#159): the last seat of a slot under a real race. pgTAP runs in one transaction and
// cannot race, so this opens 20 connections and books the same capacity-1 slot at once.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asGuest, connect, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

/** A committed org with one bookable 30-minute service open 08:00-18:00 every day (UTC). */
async function bookableWorld() {
  const orgId = randomUUID();
  const locationId = randomUUID();
  const queueId = randomUUID();
  const serviceId = randomUUID();
  const slug = 'book-' + locationId;
  await admin.begin(async (tx) => {
    await tx`insert into app.organizations (id, name) values (${orgId}, 'Booking race')`;
    await tx`insert into app.locations (id, org_id, name, slug, tz, booking_rate_per_min)
             values (${locationId}, ${orgId}, 'Race track', ${slug}, 'UTC', 10000)`;
    await tx`insert into app.queues (id, org_id, location_id, name, ticket_prefix)
             values (${queueId}, ${orgId}, ${locationId}, 'Races', 'R')`;
    await tx`insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
             values (${serviceId}, ${orgId}, ${locationId}, ${queueId}, 'Cut', 30)`;
    await tx`insert into app.booking_policies (org_id, service_id, bookable, slot_minutes, min_notice_minutes)
             values (${orgId}, ${serviceId}, true, 30, 0)`;
    for (let weekday = 0; weekday < 7; weekday++) {
      await tx`insert into app.business_hours (org_id, location_id, weekday, opens, closes)
               values (${orgId}, ${locationId}, ${weekday}, '08:00', '18:00')`;
    }
  });
  return { orgId, serviceId, slug };
}

function tomorrowNoonUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

describe('book_appointment under concurrency', () => {
  it('AC1: 20 parallel bookings of a capacity-1 slot give exactly one appointment and 19 slot_full', async () => {
    const world = await bookableWorld();
    const slot = tomorrowNoonUtc();
    const guests = connect(20);
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          asGuest(guests, async (tx) => {
            await tx`select api.book_appointment(${world.slug}, ${world.serviceId}, ${slot}, ${'Racer ' + i},
                                                 ${'+1555000' + String(1000 + i)}, null, 1, null, ${randomUUID()})`;
            return 'booked';
          }).catch((e: { message?: string }) => e.message ?? 'error'),
        ),
      );
      expect(outcomes.filter((o) => o === 'booked')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'slot_full')).toHaveLength(19);

      const [count] = await admin<{ n: number }[]>`
        select count(*)::int as n from app.appointments where service_id = ${world.serviceId}`;
      expect(count!.n).toBe(1);
      const [seats] = await admin<{ count: number }[]>`
        select count from app.appointment_slot_counts where service_id = ${world.serviceId}`;
      expect(seats!.count).toBe(1);
    } finally {
      await guests.end();
    }
  });
});
