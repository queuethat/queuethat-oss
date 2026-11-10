/**
 * Staff actions taken while offline (S-12, #274). Every mutation already carries an idempotency
 * key and `expected_version`, so an action captured here can be replayed safely: a repeat is a
 * no-op on the server and a visit that changed meanwhile fails with `stale_visit`, which is held
 * as a conflict for a person to review (never dropped, never silently overwritten).
 */

export type OfflineRpc = 'transition_visit' | 'staff_add_visit';

export interface OfflineAction {
  id: string;
  rpc: OfflineRpc;
  /** The RPC arguments, including `p_idempotency_key` and (for visits) `p_expected_version`. */
  args: Record<string, unknown>;
  /** The visit the action is on, null for a new walk-in. A conflict holds this visit's later actions. */
  visitId: string | null;
  /** What it did, for the review panel (the console's own words are looked up from this). */
  label: { action: string; ticket: string | null; name: string | null };
  created_at: string;
  status: 'pending' | 'conflict';
  /** The database's error code when `status` is `conflict`. */
  conflict?: string;
}

/** Durable storage; IndexedDB in the browser, anything keyed by id in tests. */
export interface OfflineStore {
  all(): Promise<OfflineAction[]>;
  put(action: OfflineAction): Promise<void>;
  delete(id: string): Promise<void>;
}

/** How a send ended: done, refused by the database (`code`), or never got through. */
export type SendResult = { ok: true } | { ok: false; code: string } | { ok: false; network: true };

/** Codes that mean "the world moved on": a person decides, replaying again won't help. */
const CONFLICT_CODES = new Set([
  'stale_visit',
  'illegal_transition',
  'not_found',
  'invalid_input',
  'queue_not_accepting',
  'capacity_reached',
  'org_suspended',
  'undo_not_allowed',
]);

export class OfflineUnavailableError extends Error {
  constructor() {
    super('offline_queue_unavailable');
  }
}

/** The IndexedDB store; opening rejects where storage is blocked (private mode). */
export function indexedDbStore(name = 'qm-offline'): OfflineStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('actions', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('actions', mode);
        const request = fn(tx.objectStore('actions'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    all: async () =>
      (await run('readonly', (s) => s.getAll() as IDBRequest<OfflineAction[]>)).sort(
        (a: OfflineAction, b: OfflineAction) => a.created_at.localeCompare(b.created_at),
      ),
    put: async (action) => void (await run('readwrite', (s) => s.put(action))),
    delete: async (id) => void (await run('readwrite', (s) => s.delete(id))),
  };
}

export function createOfflineQueue(
  store: OfflineStore,
  send: (a: OfflineAction) => Promise<SendResult>,
) {
  let actions: OfflineAction[] = [];
  let available = true;
  let replaying: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const ready = store.all().then(
    (rows) => {
      actions = rows;
      emit();
    },
    () => {
      // Storage refused: say so rather than pretend actions are safe.
      available = false;
      emit();
    },
  );

  async function replayAll() {
    await ready;
    const held = new Set<string>();
    for (const action of [...actions]) {
      if (action.status === 'conflict') {
        if (action.visitId) held.add(action.visitId);
        continue;
      }
      if (action.visitId && held.has(action.visitId)) continue;
      const result = await send(action);
      if (result.ok) {
        await store.delete(action.id);
        actions = actions.filter((a) => a.id !== action.id);
      } else if ('network' in result || !CONFLICT_CODES.has(result.code)) {
        break; // Still offline (or signed out): keep everything, in order, and try again later.
      } else {
        const conflict = { ...action, status: 'conflict' as const, conflict: result.code };
        await store.put(conflict);
        actions = actions.map((a) => (a.id === action.id ? conflict : a));
        if (action.visitId) held.add(action.visitId);
      }
      emit();
    }
    emit();
  }

  return {
    /** False when storage is blocked; the console shows a banner and does not queue. */
    isAvailable: () => available,
    snapshot: () => actions,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Stores the action durably before returning; throws where storage is unavailable. */
    async enqueue(
      input: Pick<OfflineAction, 'rpc' | 'args' | 'visitId' | 'label'>,
    ): Promise<OfflineAction> {
      await ready;
      if (!available) throw new OfflineUnavailableError();
      const action: OfflineAction = {
        id: crypto.randomUUID(),
        ...input,
        created_at: new Date().toISOString(),
        status: 'pending',
      };
      try {
        await store.put(action);
      } catch {
        available = false;
        emit();
        throw new OfflineUnavailableError();
      }
      actions = [...actions, action];
      emit();
      return action;
    },
    /** Replays pending actions in order; concurrent calls share one run. */
    replay(): Promise<void> {
      replaying ??= replayAll().finally(() => (replaying = null));
      return replaying;
    },
    /** Drops an action the person chose not to apply. */
    async discard(id: string) {
      await store.delete(id);
      actions = actions.filter((a) => a.id !== id);
      emit();
    },
    /** Re-queues a conflict with new arguments (fresh key and version) for the next replay. */
    async retry(id: string, args: Record<string, unknown>) {
      const old = actions.find((a) => a.id === id);
      if (!old) return;
      const next: OfflineAction = { ...old, args, status: 'pending', conflict: undefined };
      await store.put(next);
      actions = actions.map((a) => (a.id === id ? next : a));
      emit();
    },
  };
}

export type OfflineQueue = ReturnType<typeof createOfflineQueue>;
