// 2A-Q4 (#103): per-service ticket prefixes number independently under parallel joins (AC2).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asGuest, connect, createWorld, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

describe('service ticket prefixes under concurrency', () => {
  it('AC2: 50 parallel joins split over two prefixes leave no gaps or duplicates in either', async () => {
    const world = await createWorld(admin);
    const [queue] = await admin<{ location_id: string }[]>`
      select location_id from app.queues where id = ${world.queueId}`;
    const registrations = randomUUID();
    const licences = randomUUID();
    await admin`insert into app.services (id, org_id, location_id, name, ticket_prefix)
                values (${registrations}, ${world.orgId}, ${queue!.location_id}, 'Registrations', 'B'),
                       (${licences}, ${world.orgId}, ${queue!.location_id}, 'Licences', null)`;
    await admin`insert into app.queue_services (org_id, location_id, queue_id, service_id)
                values (${world.orgId}, ${queue!.location_id}, ${world.queueId}, ${registrations}),
                       (${world.orgId}, ${queue!.location_id}, ${world.queueId}, ${licences})`;

    const guests = connect(20);
    try {
      const tickets = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          asGuest(guests, async (tx) => {
            const [row] =
              await tx`select * from api.join_queue(${world.queueId}, ${i % 2 === 0 ? registrations : licences},
                                                                'Racer', null, null, 1, null, ${randomUUID()}, null)`;
            return row!.display_ticket as string;
          }),
        ),
      );
      const expected = (prefix: string) =>
        Array.from({ length: 25 }, (_, i) => prefix + String(i + 1).padStart(3, '0'));
      expect(tickets.filter((t) => t.startsWith('B')).sort()).toEqual(expected('B'));
      expect(tickets.filter((t) => t.startsWith('R')).sort()).toEqual(expected('R'));
    } finally {
      await guests.end();
    }
  });
});
