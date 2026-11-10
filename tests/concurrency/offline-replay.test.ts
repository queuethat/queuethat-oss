// 2B-S4 (#274): actions queued offline replay safely. The queue is the real one; the sender calls
// api.transition_visit as a staff member, the way PostgREST would on reconnect.
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOfflineQueue,
  indexedDbStore,
  type OfflineAction,
  type SendResult,
} from '../../apps/web/src/lib/offline-queue';
import { asStaff, callNext, connect, createWorld, staffAdd, type Sql } from './db';

let admin: Sql;
beforeAll(() => {
  admin = connect(2);
});
afterAll(async () => {
  await admin.end();
});

const sender =
  (sql: Sql, userId: string) =>
  async (a: OfflineAction): Promise<SendResult> => {
    try {
      await asStaff(
        sql,
        userId,
        (tx) =>
          tx`select api.transition_visit(${a.args.p_visit_id as string}, ${a.args.p_action as string}::api.visit_action,
              ${a.args.p_expected_version as number}, ${a.args.p_idempotency_key as string})`,
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e as Error).message };
    }
  };

async function servingVisit() {
  const world = await createWorld(admin);
  const staffId = world.staff[0];
  const visitId = await staffAdd(admin, staffId, world.queueId);
  await callNext(admin, staffId, world.queueId, world.counters[0], randomUUID());
  const versionOf = async () =>
    Number(
      (await admin<{ version: number }[]>`select version from app.visits where id = ${visitId}`)[0]!
        .version,
    );
  const calledVersion = await versionOf();
  await asStaff(
    admin,
    staffId,
    (tx) =>
      tx`select api.transition_visit(${visitId}, 'start'::api.visit_action, ${calledVersion}, ${randomUUID()})`,
  );
  return { world, staffId, visitId, version: await versionOf() };
}

const completes = async (visitId: string) =>
  (await admin`select 1 from app.visit_events where visit_id = ${visitId} and to_status = 'served'`)
    .length;

const action = (visitId: string, version: number, key: string) => ({
  rpc: 'transition_visit' as const,
  args: {
    p_visit_id: visitId,
    p_action: 'complete',
    p_expected_version: version,
    p_idempotency_key: key,
  },
  visitId,
  label: { action: 'complete', ticket: 'R001', name: null },
});

describe('offline replay against the database', () => {
  it('AC1+AC2: the same queued action replayed by two tabs at once gives one complete event', async () => {
    const { staffId, visitId, version } = await servingVisit();
    const pool = connect(4);
    try {
      const key = randomUUID();
      const store = indexedDbStore('replay-1');
      const tabA = createOfflineQueue(store, sender(pool, staffId));
      await tabA.enqueue(action(visitId, version, key));
      const tabB = createOfflineQueue(store, sender(pool, staffId));
      await Promise.all([tabA.replay(), tabB.replay()]);
      expect(await completes(visitId)).toBe(1);
      const [v] = await admin`select status from app.visits where id = ${visitId}`;
      expect(v!.status).toBe('served');
    } finally {
      await pool.end();
    }
  });

  it('AC3: another tablet changed the visit, so replay marks a conflict and applies nothing', async () => {
    const { staffId, visitId, version } = await servingVisit();
    const pool = connect(2);
    try {
      const q = createOfflineQueue(indexedDbStore('replay-2'), sender(pool, staffId));
      await q.enqueue(action(visitId, version, randomUUID()));
      await q.enqueue(action(visitId, version, randomUUID()));
      // Tablet B completes the visit first, under its own key.
      await asStaff(
        admin,
        staffId,
        (tx) =>
          tx`select api.transition_visit(${visitId}, 'complete'::api.visit_action, ${version}, ${randomUUID()})`,
      );
      await q.replay();
      const [first, second] = q.snapshot();
      expect(first).toMatchObject({ status: 'conflict' });
      expect(['stale_visit', 'illegal_transition']).toContain(first!.conflict);
      expect(second).toMatchObject({ status: 'pending' });
      // Only tablet B's complete exists; nothing of tablet A's was applied.
      expect(await completes(visitId)).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
