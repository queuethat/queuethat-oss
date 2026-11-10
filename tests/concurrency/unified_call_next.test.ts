// 2P-APT13 (#169): two tablets calling next on a queue mixing walk-ins and checked-in appointments.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, callNext, connect, createWorld, join, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

describe('call_next on a mixed queue', () => {
  it('AC3: concurrent calls never call a visit twice and call every waiting guest once', async () => {
    const world = await createWorld(admin);
    const guests = connect(10);
    try {
      await Promise.all(Array.from({ length: 6 }, () => join(guests, world.queueId)));
    } finally {
      await guests.end();
    }
    // Four appointments for now, each checked in by staff at its place.
    const appointmentVisits: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await admin.begin(async (tx) => {
        await tx`select private.set_actor('system', null)`;
        const [q] = await tx<{ location_id: string; ticket_prefix: string }[]>`
          select location_id, ticket_prefix from app.queues where id = ${world.queueId}`;
        const vid = randomUUID();
        const [n] = await tx<{ next: number }[]>`
          select private.next_ticket(${world.queueId}, ${q!.ticket_prefix}, private.service_day(${q!.location_id})) as next`;
        await tx`insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                                         display_ticket, status, sort_key, guest_token_hash, source, idempotency_key, scheduled_at)
                 values (${vid}, ${world.orgId}, ${q!.location_id}, ${world.queueId},
                         private.service_day(${q!.location_id}), ${q!.ticket_prefix}, ${n!.next},
                         ${q!.ticket_prefix + 'A' + n!.next}, 'expected', ${n!.next * 1024},
                         private.token_hash(${vid}), 'appointment', ${randomUUID()}, now() + interval '2 minutes')`;
        return vid;
      });
      appointmentVisits.push(id);
    }
    for (const id of appointmentVisits) {
      await asStaff(admin, world.staff[0], async (tx) => {
        const [v] = await tx<
          { version: number }[]
        >`select version from app.visits where id = ${id}`;
        await tx`select api.transition_visit(${id}, 'check_in', ${v!.version}, ${randomUUID()})`;
      });
    }

    const pool = connect(10);
    try {
      const calls = await Promise.all(
        Array.from({ length: 14 }, (_, i) =>
          callNext(pool, world.staff[i % 2]!, world.queueId, world.counters[i % 2]!, randomUUID()),
        ),
      );
      const called = calls.filter((id): id is string => id !== null);
      expect(called).toHaveLength(10);
      expect(new Set(called).size).toBe(10);
    } finally {
      await pool.end();
    }
  });
});
