// V8 (#37): "nobody gets lost" under real races. pgTAP runs in one transaction and cannot race,
// so these tests open many connections to the local database and fire the RPCs at once.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asGuest, callNext, connect, createWorld, join, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

/** Fires `n` calls of `fn` together on one pool and waits for all of them. */
function burst<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

async function visits(queueId: string) {
  return admin<{ id: string; ticket_number: number; status: string; call_count: number }[]>`
    select id, ticket_number, status, call_count from app.visits
    where queue_id = ${queueId} order by ticket_number`;
}

async function callEvents(queueId: string) {
  const rows = await admin<{ visit_id: string }[]>`
    select e.visit_id from app.visit_events e
    join app.visits v on v.id = e.visit_id
    where v.queue_id = ${queueId} and e.type = 'call'`;
  return rows.map((r) => r.visit_id);
}

describe('join_queue under concurrency', () => {
  it('AC1: 100 parallel joins get ticket numbers 1..100, each exactly once', async () => {
    const world = await createWorld(admin);
    const guests = connect(25);
    try {
      const results = await burst(100, () => join(guests, world.queueId));

      const tickets = results.map((r) => r.display_ticket).sort();
      expect(new Set(tickets).size).toBe(100);
      expect(tickets).toEqual(
        Array.from({ length: 100 }, (_, i) => 'R' + String(i + 1).padStart(3, '0')),
      );
      expect(results.every((r) => r.status === 'waiting' && r.token)).toBe(true);

      const rows = await visits(world.queueId);
      expect(rows.map((r) => r.ticket_number)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
    } finally {
      await guests.end();
    }
  });

  it('a double-tapped join (same key on 10 connections) creates one visit, all with its token from that phone', async () => {
    const world = await createWorld(admin);
    const phone = connect(10);
    try {
      const key = randomUUID();
      const device = randomUUID().replaceAll('-', '');
      const results = await burst(10, () => join(phone, world.queueId, key, device));

      expect(new Set(results.map((r) => r.display_ticket))).toEqual(new Set(['R001']));
      // #474: every replay from the phone that joined returns the token, so a lost response still
      // gets the link.
      expect(new Set(results.map((r) => r.token))).toEqual(new Set([results[0]!.token]));
      expect(results[0]!.token).not.toBeNull();
      expect(await visits(world.queueId)).toHaveLength(1);
    } finally {
      await phone.end();
    }
  });

  it('one phone joining on 10 connections with fresh keys (#474) creates one visit', async () => {
    const world = await createWorld(admin);
    const phone = connect(10);
    try {
      const device = randomUUID().replaceAll('-', '');
      const results = await burst(10, () => join(phone, world.queueId, randomUUID(), device));

      expect(new Set(results.map((r) => r.display_ticket))).toEqual(new Set(['R001']));
      expect(new Set(results.map((r) => r.token)).size).toBe(1);
      expect(await visits(world.queueId)).toHaveLength(1);
    } finally {
      await phone.end();
    }
  });
});

describe('call_next under concurrency', () => {
  it('AC2: two tablets calling 50 times each never call a visit twice', async () => {
    const world = await createWorld(admin);
    const guests = connect(10);
    // Each tablet is its own pool, so its 50 calls race each other as well as the other tablet.
    const tablets = [connect(5), connect(5)];
    try {
      await burst(100, () => join(guests, world.queueId));

      const called = (
        await Promise.all(
          tablets.map((tablet, t) =>
            burst(50, () =>
              callNext(tablet, world.staff[t]!, world.queueId, world.counters[t]!, randomUUID()),
            ),
          ),
        )
      ).flat();

      expect(called).not.toContain(null);
      expect(new Set(called).size).toBe(100);

      const rows = await visits(world.queueId);
      expect(rows.every((r) => r.status === 'called' && r.call_count === 1)).toBe(true);
      const events = await callEvents(world.queueId);
      expect(events).toHaveLength(100);
      expect(new Set(events).size).toBe(100);

      expect(
        await callNext(tablets[0]!, world.staff[0], world.queueId, world.counters[0], randomUUID()),
      ).toBeNull();
    } finally {
      await Promise.all([guests.end(), ...tablets.map((t) => t.end())]);
    }
  });

  it('a double-tapped call (same key on two connections) calls one visit once', async () => {
    const world = await createWorld(admin);
    const guests = connect(3);
    const tablet = connect(2);
    try {
      await burst(3, () => join(guests, world.queueId));

      const key = randomUUID();
      const [first, second] = await burst(2, () =>
        callNext(tablet, world.staff[0], world.queueId, world.counters[0], key),
      );

      expect(first).not.toBeNull();
      expect(second).toBe(first);
      const rows = await visits(world.queueId);
      expect(rows.filter((r) => r.status === 'called').map((r) => r.id)).toEqual([first]);
      expect(await callEvents(world.queueId)).toEqual([first]);
    } finally {
      await Promise.all([guests.end(), tablet.end()]);
    }
  });

  // The call of one tablet queues `almost_up` messages for the next guests in line. Inserting a
  // message takes a KEY SHARE lock on the guest's visit through its foreign key, and `FOR UPDATE
  // SKIP LOCKED` treats that as taken: the other tablet then jumped over that guest.
  it('a guest whose row is key-share locked still goes in line order', async () => {
    const world = await createWorld(admin);
    const guests = connect(3);
    const tablet = connect(2);
    const holder = connect(1);
    try {
      // In a row, so the held guest is certainly second in line.
      for (let i = 0; i < 3; i++) await join(guests, world.queueId);
      const [secondVisit] = await admin<{ id: string }[]>`
        select id from app.visits where queue_id = ${world.queueId} and ticket_number = 2`;

      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const lock = holder.begin(async (tx) => {
        await tx`select 1 from app.visits where id = ${secondVisit!.id} for key share`;
        locked();
        await gate;
      });
      await holding;
      try {
        const calls: (string | null)[] = [];
        for (let i = 0; i < 2; i++) {
          calls.push(
            await callNext(tablet, world.staff[0], world.queueId, world.counters[0], randomUUID()),
          );
        }
        const rows = await visits(world.queueId);
        const ticket = (id: string | null) => rows.find((r) => r.id === id)?.ticket_number;
        expect(calls.map(ticket)).toEqual([1, 2]);
        expect(rows.map((r) => r.status)).toEqual(['called', 'called', 'waiting']);
      } finally {
        release();
        await lock;
      }
    } finally {
      await Promise.all([guests.end(), tablet.end(), holder.end()]);
    }
  });

  it('two tablets calling together take the first two guests, whoever has a contact on file', async () => {
    const world = await createWorld(admin);
    const guests = connect(4);
    const tablets = [connect(1), connect(1)];
    try {
      for (let round = 0; round < 15; round++) {
        const base = round * 4;
        // In a row: each guest leaves an email, so every call queues `almost_up` for the next two.
        for (let i = 0; i < 4; i++) {
          await asGuest(
            guests,
            (tx) => tx`select api.join_queue(${world.queueId}, null, 'Racer',
            null, ${`r${round}g${i}@concurrency.test`}, 1, null, ${randomUUID()}, null)`,
          );
        }
        const called = await Promise.all(
          tablets.map((tablet, t) =>
            callNext(tablet, world.staff[t]!, world.queueId, world.counters[t]!, randomUUID()),
          ),
        );
        const rows = await visits(world.queueId);
        const numbers = called
          .map((id) => rows.find((r) => r.id === id)?.ticket_number)
          .sort((a, b) => (a ?? 0) - (b ?? 0));
        expect(numbers, `round ${round}`).toEqual([base + 1, base + 2]);
        // Clear the other two so the next round starts with an empty line.
        for (let i = 0; i < 2; i++) {
          await callNext(
            tablets[0]!,
            world.staff[0],
            world.queueId,
            world.counters[0],
            randomUUID(),
          );
        }
      }
    } finally {
      await Promise.all([guests.end(), ...tablets.map((t) => t.end())]);
    }
  });
});
