import { errorCode } from '@qm/domain';
import { useEffect, useSyncExternalStore } from 'react';
import { queryClient } from '../../../lib/query.ts';
import { supabase } from '../../../lib/supabase.ts';
import {
  createOfflineQueue,
  indexedDbStore,
  type OfflineAction,
  type OfflineQueue,
  type OfflineStore,
  type SendResult,
} from '../../../lib/offline-queue.ts';

/** A browser without usable IndexedDB gets a queue that reports itself unavailable. */
const unavailable: OfflineStore = {
  all: () => Promise.reject(new Error('indexeddb_unavailable')),
  put: () => Promise.reject(new Error('indexeddb_unavailable')),
  delete: () => Promise.reject(new Error('indexeddb_unavailable')),
};

/** True for a request that never reached the server (no Postgres code, fetch-style message). */
export function isNetworkError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code !== '') return false;
  return typeof message === 'string' && /fetch|network|load failed|timeout|abort/i.test(message);
}

async function send(action: OfflineAction): Promise<SendResult> {
  const { error } = await supabase.rpc(action.rpc as 'transition_visit', action.args as never);
  if (!error) return { ok: true };
  if (isNetworkError(error)) return { ok: false, network: true };
  return {
    ok: false,
    code: errorCode(error) === 'unknown' ? (error.message ?? '') : errorCode(error),
  };
}

let queue: OfflineQueue | null = null;

/** The one queue for this tab; created on first use so tests and guest pages never open IndexedDB. */
export function offlineQueue(): OfflineQueue {
  queue ??= createOfflineQueue(
    typeof indexedDB === 'undefined' ? unavailable : indexedDbStore(),
    send,
  );
  return queue;
}

/** Replays now and refreshes the console list, whatever the outcome. */
export function replayOffline() {
  return offlineQueue()
    .replay()
    .finally(() => queryClient.invalidateQueries({ queryKey: ['console', 'visits'] }));
}

/** A queued action answers like a visit row so callers keep one code path; `queued` marks it. */
export type QueuedRow = { queued: true; display_ticket: string | null; last_event_id: null };

export function isQueued(row: unknown): row is QueuedRow {
  return !!row && typeof row === 'object' && (row as QueuedRow).queued === true;
}

/**
 * Runs an RPC; if the request never reaches the server (or the tablet is offline) the action is
 * stored with the same idempotency key, so a request that did arrive is not applied twice.
 */
export async function callOrQueue<T>(
  rpc: OfflineAction['rpc'],
  args: Record<string, unknown>,
  visitId: string | null,
  label: OfflineAction['label'],
): Promise<T | QueuedRow> {
  if (navigator.onLine) {
    const { data, error } = await supabase.rpc(rpc as 'transition_visit', args as never);
    if (!error) return data as T;
    if (!isNetworkError(error)) throw error;
  }
  await offlineQueue().enqueue({ rpc, args, visitId, label });
  return { queued: true, display_ticket: label.ticket, last_event_id: null };
}

const onlineStore = {
  subscribe(cb: () => void) {
    window.addEventListener('online', cb);
    window.addEventListener('offline', cb);
    return () => {
      window.removeEventListener('online', cb);
      window.removeEventListener('offline', cb);
    };
  },
  get: () => navigator.onLine,
};

/** Whether the browser thinks it has a network. */
export function useOnline(): boolean {
  return useSyncExternalStore(onlineStore.subscribe, onlineStore.get, () => true);
}

/** The stored actions, live. */
export function useOfflineActions(): { actions: OfflineAction[]; available: boolean } {
  const q = offlineQueue();
  const actions = useSyncExternalStore(q.subscribe, q.snapshot, q.snapshot);
  return { actions, available: q.isAvailable() };
}

/** Replays on mount and whenever the browser comes back online. */
export function useOfflineReplay() {
  useEffect(() => {
    void replayOffline();
    const on = () => void replayOffline();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, []);
}
