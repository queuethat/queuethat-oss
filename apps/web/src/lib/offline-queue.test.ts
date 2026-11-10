import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createOfflineQueue,
  indexedDbStore,
  OfflineUnavailableError,
  type OfflineAction,
  type OfflineStore,
  type SendResult,
} from './offline-queue.ts';

const label = { action: 'complete', ticket: 'A001', name: null };
const input = (visitId: string | null, key: string) => ({
  rpc: 'transition_visit' as const,
  args: { p_idempotency_key: key, p_expected_version: 3 },
  visitId,
  label,
});

let n = 0;
beforeEach(() => void n++);
const fresh = () => indexedDbStore(`test-${n}`);

describe('offline queue', () => {
  it('survives a reload: a new queue on the same store sees the action', async () => {
    const store = fresh();
    await createOfflineQueue(store, async () => ({ ok: true })).enqueue(input('v1', 'k1'));
    const again = createOfflineQueue(store, async () => ({ ok: true }));
    await again.replay();
    expect(again.snapshot()).toHaveLength(0);
  });

  it('replays in order and removes what was applied', async () => {
    const sent: string[] = [];
    const q = createOfflineQueue(fresh(), async (a) => {
      sent.push(a.args.p_idempotency_key as string);
      return { ok: true };
    });
    await q.enqueue(input('v1', 'k1'));
    await q.enqueue(input('v2', 'k2'));
    await q.replay();
    expect(sent).toEqual(['k1', 'k2']);
    expect(q.snapshot()).toHaveLength(0);
  });

  it('keeps the action, with the same key, when the network is still down (replay twice = same key)', async () => {
    const keys: unknown[] = [];
    let result: SendResult = { ok: false, network: true };
    const q = createOfflineQueue(fresh(), async (a) => {
      keys.push(a.args.p_idempotency_key);
      return result;
    });
    await q.enqueue(input('v1', 'k1'));
    await q.replay();
    expect(q.snapshot()).toHaveLength(1);
    result = { ok: true };
    await q.replay();
    expect(keys).toEqual(['k1', 'k1']);
    expect(q.snapshot()).toHaveLength(0);
  });

  it("marks stale_visit as a conflict and holds that visit's later actions only", async () => {
    const sent: string[] = [];
    const q = createOfflineQueue(fresh(), async (a) => {
      sent.push(a.args.p_idempotency_key as string);
      return a.args.p_idempotency_key === 'k1' ? { ok: false, code: 'stale_visit' } : { ok: true };
    });
    await q.enqueue(input('v1', 'k1'));
    await q.enqueue(input('v1', 'k2'));
    await q.enqueue(input('v2', 'k3'));
    await q.replay();
    expect(sent).toEqual(['k1', 'k3']);
    expect(q.snapshot().map((a) => [a.args.p_idempotency_key, a.status, a.conflict])).toEqual([
      ['k1', 'conflict', 'stale_visit'],
      ['k2', 'pending', undefined],
    ]);
  });

  it('shares one run between concurrent replays', async () => {
    let calls = 0;
    const q = createOfflineQueue(fresh(), async () => {
      calls++;
      return { ok: true };
    });
    await q.enqueue(input('v1', 'k1'));
    await Promise.all([q.replay(), q.replay()]);
    expect(calls).toBe(1);
  });

  it('retry re-queues a conflict with new arguments; discard removes it', async () => {
    const q = createOfflineQueue(fresh(), async () => ({ ok: false, code: 'stale_visit' }));
    const a = await q.enqueue(input('v1', 'k1'));
    await q.replay();
    await q.retry(a.id, { p_idempotency_key: 'k9', p_expected_version: 5 });
    expect(q.snapshot()[0]).toMatchObject({ status: 'pending', args: { p_idempotency_key: 'k9' } });
    await q.discard(a.id);
    expect(q.snapshot()).toHaveLength(0);
  });

  it('refuses to queue, loudly, when storage fails', async () => {
    const broken: OfflineStore = {
      all: async () => [] as OfflineAction[],
      put: async () => Promise.reject(new Error('quota')),
      delete: async () => {},
    };
    const q = createOfflineQueue(broken, async () => ({ ok: true }));
    await expect(q.enqueue(input('v1', 'k1'))).rejects.toBeInstanceOf(OfflineUnavailableError);
    expect(q.isAvailable()).toBe(false);
  });
});
