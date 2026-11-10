// 2B-Q5 (#230): call_next over visits assigned by round-robin, under real races (AC3).
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

describe('call_next with round-robin assignment', () => {
  it('AC3: two counters calling 50 times each never double-call', async () => {
    const world = await createWorld(admin);
    await admin`update app.queues set assignment_strategy = 'round_robin' where id = ${world.queueId}`;

    const guests = connect(20);
    try {
      await Promise.all(Array.from({ length: 60 }, () => join(guests, world.queueId)));
    } finally {
      await guests.end();
    }
    const assigned = await admin<{ assigned_counter_id: string; n: number }[]>`
      select assigned_counter_id, count(*)::int as n from app.visits
      where queue_id = ${world.queueId} group by 1`;
    expect(assigned.every((r) => world.counters.includes(r.assigned_counter_id))).toBe(true);

    const pool = connect(12);
    try {
      const calls = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          callNext(pool, world.staff[i % 2]!, world.queueId, world.counters[i % 2]!, randomUUID()),
        ),
      );
      const called = calls.filter((id): id is string => id !== null);
      expect(new Set(called).size).toBe(called.length);
      const rows = await admin<{ call_count: number; counter_id: string; assigned: string }[]>`
        select call_count, counter_id, assigned_counter_id as assigned from app.visits
        where queue_id = ${world.queueId} and status = 'called'`;
      expect(rows).toHaveLength(called.length);
      expect(rows.every((r) => r.call_count === 1)).toBe(true);
      // Assigned guests are only ever called at their own counter.
      expect(rows.every((r) => r.assigned === r.counter_id)).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
