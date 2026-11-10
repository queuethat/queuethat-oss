// M4 (#1291): two providers drain a shared "Anyone available" pool at the same time. SKIP LOCKED must give
// each pool guest to exactly one of them, and a provider's own line must still be served.
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

describe('call_next with a pool', () => {
  it('two providers racing for the pool never double-call and every guest is served once', async () => {
    const world = await createWorld(admin);
    const [loc] = await admin<{ location_id: string }[]>`
      select location_id from app.queues where id = ${world.queueId}`;
    const pool = randomUUID();
    const second = randomUUID();
    await admin`insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind, join_rate_per_min)
                values (${pool}, ${world.orgId}, ${loc!.location_id}, 'Anyone available', 'P', 'pool', 10000)`;
    await admin`insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind, join_rate_per_min)
                values (${second}, ${world.orgId}, ${loc!.location_id}, 'Second provider', 'S', 'provider', 10000)`;
    await admin`update app.queues set kind = 'provider', pulls_from = ${pool} where id in (${world.queueId}, ${second})`;

    const guests = connect(20);
    try {
      await Promise.all([
        ...Array.from({ length: 20 }, () => join(guests, pool)),
        ...Array.from({ length: 5 }, () => join(guests, world.queueId)),
      ]);
    } finally {
      await guests.end();
    }

    const callers = connect(12);
    try {
      const calls = await Promise.all(
        Array.from({ length: 60 }, (_, i) => {
          const who = i % 2;
          return callNext(
            callers,
            world.staff[who]!,
            who === 0 ? world.queueId : second,
            world.counters[who]!,
            randomUUID(),
          );
        }),
      );
      const called = calls.filter((id): id is string => id !== null);
      expect(new Set(called).size).toBe(called.length);

      const rows = await admin<{ queue_id: string; call_count: number }[]>`
        select queue_id, call_count from app.visits
        where org_id = ${world.orgId} and status = 'called'`;
      // 25 guests, 60 calls: everyone is called once.
      expect(rows).toHaveLength(25);
      expect(rows.every((r) => r.call_count === 1)).toBe(true);
      expect(rows.filter((r) => r.queue_id === world.queueId)).toHaveLength(5);
      expect(rows.filter((r) => r.queue_id === pool)).toHaveLength(20);
    } finally {
      await callers.end();
    }
  });
});
