// 2A-Q2 (#101): call_next with service mapping and assignment under real races (AC3).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callNext, connect, createWorld, join, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

describe('call_next with a mapped service', () => {
  it('AC3: two counters calling 30 times each never double-call and never call an ineligible visit', async () => {
    const world = await createWorld(admin);
    const [locRow] = await admin<{ location_id: string }[]>`
      select location_id from app.queues where id = ${world.queueId}`;
    const locationId = locRow!.location_id;
    const colour = randomUUID();
    const cut = randomUUID();
    await admin`insert into app.services (id, org_id, location_id, queue_id, name)
                values (${colour}, ${world.orgId}, ${locationId}, ${world.queueId}, 'Colour'),
                       (${cut}, ${world.orgId}, ${locationId}, ${world.queueId}, 'Cut')`;
    // Colour is served only at counter 0; Cut anywhere.
    await admin`insert into app.service_resources (org_id, location_id, service_id, counter_id)
                values (${world.orgId}, ${locationId}, ${colour}, ${world.counters[0]})`;

    const guests = connect(20);
    try {
      const joined = await Promise.all(
        Array.from({ length: 40 }, () => join(guests, world.queueId)),
      );
      expect(joined).toHaveLength(40);
    } finally {
      await guests.end();
    }
    await admin.begin(async (tx) => {
      await tx`select private.set_actor('system', null)`;
      await tx`update app.visits set service_id = case when ticket_number % 2 = 0 then ${colour}::uuid
                                                       else ${cut}::uuid end
               where queue_id = ${world.queueId}`;
    });

    const pool = connect(12);
    try {
      const calls = await Promise.all(
        Array.from({ length: 60 }, (_, i) => {
          const who = i % 2;
          return callNext(
            pool,
            world.staff[who]!,
            world.queueId,
            world.counters[who]!,
            randomUUID(),
          );
        }),
      );
      const called = calls.filter((id): id is string => id !== null);
      expect(new Set(called).size).toBe(called.length);

      const rows = await admin<{ service_id: string; counter_id: string; call_count: number }[]>`
        select service_id, counter_id, call_count from app.visits
        where queue_id = ${world.queueId} and status = 'called'`;
      expect(rows).toHaveLength(called.length);
      expect(rows.every((r) => r.call_count === 1)).toBe(true);
      // Nobody at counter 1 was handed a Colour guest.
      expect(
        rows.filter((r) => r.counter_id === world.counters[1] && r.service_id === colour),
      ).toEqual([]);
      // Counter 0 alone makes 30 calls and can serve anyone, so at least those were served.
      expect(called.length).toBeGreaterThanOrEqual(30);
    } finally {
      await pool.end();
    }
  });
});
