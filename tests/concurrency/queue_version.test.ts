// Every join signals the queue (queues.version), and the queue lock that takes never deadlocks
// against other joins, staff adds, set_queue_state or call_next (follow-up to V4, #432).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callNext,
  connect,
  createWorld,
  join,
  queueVersion,
  setQueueState,
  staffAdd,
  type Sql,
} from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

/** Fires all calls at once and returns each outcome; never rejects. */
function race<T>(calls: (() => Promise<T>)[]) {
  return Promise.allSettled(calls.map((call) => call()));
}

function errors(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as { code?: string; message?: string }).message ?? String(r.reason));
}

async function visitCount(queueId: string) {
  const [row] = await admin`select count(*)::int as n from app.visits where queue_id = ${queueId}`;
  return row!.n as number;
}

describe('queue version under concurrent joins', () => {
  it('anon joins, staff adds and a pause racing each other never deadlock, and each join bumps once', async () => {
    const world = await createWorld(admin);
    const pool = connect(25);
    try {
      const before = await queueVersion(admin, world.queueId);
      const results = await race<unknown>([
        ...Array.from({ length: 30 }, () => () => join(pool, world.queueId)),
        ...Array.from({ length: 15 }, () => () => staffAdd(pool, world.staff[0], world.queueId)),
        () => setQueueState(pool, world.staff[1], world.queueId, 'paused'),
      ]);

      // Joins that lose the race to the pause are rejected as paused; nothing else may fail.
      expect(errors(results).filter((e) => e !== 'queue_not_accepting')).toEqual([]);
      expect(results.at(-1)!.status).toBe('fulfilled');
      const joined = await visitCount(world.queueId);
      expect(joined).toBe(results.filter((r) => r.status === 'fulfilled').length - 1);
      expect(await queueVersion(admin, world.queueId)).toBe(before + joined + 1);
    } finally {
      await pool.end();
    }
  });

  it('joins racing two tablets calling next never deadlock, and every change bumps once', async () => {
    const world = await createWorld(admin);
    const guests = connect(10);
    const tablets = [connect(5), connect(5)];
    try {
      const before = await queueVersion(admin, world.queueId);
      const results = await race<unknown>([
        ...Array.from({ length: 50 }, () => () => join(guests, world.queueId)),
        ...tablets.flatMap((tablet, t) =>
          Array.from(
            { length: 25 },
            () => () =>
              callNext(tablet, world.staff[t]!, world.queueId, world.counters[t]!, randomUUID()),
          ),
        ),
      ]);

      expect(errors(results)).toEqual([]);
      const called = results
        .slice(50)
        .filter((r) => r.status === 'fulfilled' && r.value !== null).length;
      expect(await visitCount(world.queueId)).toBe(50);
      expect(await queueVersion(admin, world.queueId)).toBe(before + 50 + called);
    } finally {
      await Promise.all([guests.end(), ...tablets.map((t) => t.end())]);
    }
  });

  it('a double-tapped join bumps the version once', async () => {
    const world = await createWorld(admin);
    const phone = connect(10);
    try {
      const before = await queueVersion(admin, world.queueId);
      const key = randomUUID();
      const results = await race(
        Array.from({ length: 10 }, () => () => join(phone, world.queueId, key)),
      );

      expect(errors(results)).toEqual([]);
      expect(await visitCount(world.queueId)).toBe(1);
      expect(await queueVersion(admin, world.queueId)).toBe(before + 1);
    } finally {
      await phone.end();
    }
  });
});
