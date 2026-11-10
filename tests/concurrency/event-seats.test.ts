// 2B-A3 (#278): the last seats of an event under a real race. 20 guests each book one seat of a 10-seat event.
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

describe('book_event_seats under concurrency', () => {
  it('AC2: 20 single-seat bookings of a 10-seat event give exactly 10 bookings and 10 event_full', async () => {
    const orgId = randomUUID();
    const locationId = randomUUID();
    const queueId = randomUUID();
    const serviceId = randomUUID();
    const eventId = randomUUID();
    await admin.begin(async (tx) => {
      await tx`insert into app.organizations (id, name) values (${orgId}, 'Event race')`;
      await tx`insert into app.locations (id, org_id, name, slug, tz, booking_rate_per_min)
               values (${locationId}, ${orgId}, 'Hall', ${'ev-' + locationId}, 'UTC', 10000)`;
      await tx`insert into app.queues (id, org_id, location_id, name, ticket_prefix)
               values (${queueId}, ${orgId}, ${locationId}, 'Events', 'E')`;
      await tx`insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
               values (${serviceId}, ${orgId}, ${locationId}, ${queueId}, 'Class', 60)`;
      await tx`insert into app.events (id, org_id, location_id, service_id, title, during, capacity, public)
               values (${eventId}, ${orgId}, ${locationId}, ${serviceId}, 'Pottery',
                       tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour'), 10, true)`;
    });
    const guests = connect(20);
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          asGuest(guests, async (tx) => {
            await tx`select api.book_event_seats(${eventId}, ${'Racer ' + i}, ${'+1555000' + String(1000 + i)},
                                                 null, 1, ${randomUUID()})`;
            return 'booked';
          }).catch((e: { message?: string }) => e.message ?? 'error'),
        ),
      );
      expect(outcomes.filter((o) => o === 'booked')).toHaveLength(10);
      expect(outcomes.filter((o) => o === 'event_full')).toHaveLength(10);
      const [row] = await admin<{ booked: number; n: number }[]>`
        select e.booked, (select count(*)::int from app.appointments where event_id = e.id) as n
        from app.events e where e.id = ${eventId}`;
      expect(row).toEqual({ booked: 10, n: 10 });
    } finally {
      await guests.end();
    }
  });
});
