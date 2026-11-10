// 2B-A1 (#276): one freed seat, an open offer and a staff booking racing for it give exactly one appointment.
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

describe('guest_claim_offer under concurrency', () => {
  it('AC3: 10 parallel claims of one offer, plus guest bookings of the same slot, leave one live appointment', async () => {
    const orgId = randomUUID();
    const locationId = randomUUID();
    const queueId = randomUUID();
    const serviceId = randomUUID();
    const slug = 'wl-' + locationId;
    await admin.begin(async (tx) => {
      await tx`insert into app.organizations (id, name) values (${orgId}, 'Waitlist race')`;
      await tx`insert into app.locations (id, org_id, name, slug, tz, booking_rate_per_min)
               values (${locationId}, ${orgId}, 'Shop', ${slug}, 'UTC', 10000)`;
      await tx`insert into app.queues (id, org_id, location_id, name, ticket_prefix)
               values (${queueId}, ${orgId}, ${locationId}, 'Cuts', 'C')`;
      await tx`insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
               values (${serviceId}, ${orgId}, ${locationId}, ${queueId}, 'Cut', 30)`;
      await tx`insert into app.booking_policies (org_id, service_id, bookable, slot_minutes, min_notice_minutes)
               values (${orgId}, ${serviceId}, true, 30, 0)`;
      for (let weekday = 0; weekday < 7; weekday++) {
        await tx`insert into app.business_hours (org_id, location_id, weekday, opens, closes)
                 values (${orgId}, ${locationId}, ${weekday}, '08:00', '18:00')`;
      }
    });
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 2);
    d.setUTCHours(12, 0, 0, 0);
    const slot = d.toISOString();
    const day = slot.slice(0, 10);
    const guests = connect(12);
    try {
      const booked = await asGuest(guests, async (tx) => {
        const [r] = await tx<{ token: string }[]>`
          select (api.book_appointment(${slug}, ${serviceId}, ${slot}, 'First', '+15550001111', null, 1, null, ${randomUUID()})).token`;
        return r!.token;
      });
      const waiting = await asGuest(guests, async (tx) => {
        const [r] = await tx<{ t: string }[]>`
          select api.guest_join_waitlist(${slug}, ${serviceId}, ${day}, null, null, 'Waiter', null, 'w@example.test', ${randomUUID()}) as t`;
        return r!.t;
      });
      await asGuest(guests, async (tx) => {
        await tx`select api.guest_cancel_appointment(${booked}, ${randomUUID()})`;
      });
      const outcomes = await Promise.all([
        ...Array.from({ length: 10 }, () =>
          asGuest(guests, async (tx) => {
            await tx`select api.guest_claim_offer(${waiting}, ${randomUUID()})`;
            return 'claimed';
          }).catch((e: { message?: string }) => e.message ?? 'error'),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          asGuest(guests, async (tx) => {
            await tx`select api.book_appointment(${slug}, ${serviceId}, ${slot}, ${'Rival ' + i}, ${'+1555000' + String(2000 + i)}, null, 1, null, ${randomUUID()})`;
            return 'booked';
          }).catch((e: { message?: string }) => e.message ?? 'error'),
        ),
      ]);
      expect(outcomes.filter((o) => o === 'booked')).toHaveLength(0);
      expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(10); // repeats return the same booking
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from app.appointments
        where service_id = ${serviceId} and starts_at = ${slot} and status::text in ('booked', 'offered')`;
      expect(row!.n).toBe(1);
    } finally {
      await guests.end();
    }
  });
});
