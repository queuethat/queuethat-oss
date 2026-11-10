// N3 (#69): api.claim_outbox under real races. Dispatchers run as the service role on their own
// connections and claim until the outbox is empty; no notification may be leased twice.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createWorld, join, type Sql } from './db';

let admin: Sql;

beforeAll(() => {
  admin = connect(2);
});

afterAll(async () => {
  await admin.end();
});

/** One dispatcher: claims batches of 10 until nothing is due, returning every id it got. */
async function drain(sql: Sql): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      return tx<{ id: string }[]>`select id from api.claim_outbox(10, 60)`;
    });
    if (rows.length === 0) return ids;
    ids.push(...rows.map((r) => r.id));
  }
}

describe('claim_outbox under concurrency', () => {
  it('AC1: four dispatchers draining 200 rows at once each receive every row exactly once', async () => {
    const world = await createWorld(admin);
    const guest = connect(1);
    const dispatchers = Array.from({ length: 4 }, () => connect(2));
    try {
      await join(guest, world.queueId);
      const [visit] = await admin<{ id: string }[]>`
        select id from app.visits where queue_id = ${world.queueId}`;
      const mine = await admin<{ id: string }[]>`
        insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                       template_version, dedupe_key)
        select ${world.orgId}, ${visit!.id}, 'email', ${randomUUID()}, 'called', 1,
               ${randomUUID()} || g
        from generate_series(1, 200) g
        returning id`;

      const claimed = (await Promise.all(dispatchers.map((d) => drain(d)))).flat();
      const ours = claimed.filter((id) => mine.some((m) => m.id === id));

      expect(ours).toHaveLength(200);
      expect(new Set(ours).size).toBe(200);
    } finally {
      await Promise.all([guest.end(), ...dispatchers.map((d) => d.end())]);
    }
  });
});
