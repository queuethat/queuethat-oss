import type { ConsoleQueue, ConsoleVisit } from '../api.ts';

type Line = Pick<ConsoleQueue, 'id' | 'kind' | 'pullsFrom'>;

/** Whether the location runs per-person lines (M4): any provider or "Anyone available" line. */
export function hasLines(queues: readonly Line[]): boolean {
  return queues.some((q) => q.kind !== 'general');
}

/**
 * The lines a member works by default: the provider lines assigned to them (`queue_ids`) plus the
 * pool each pulls from. Empty when they have no provider line of their own (front desk).
 */
export function myLineIds(queues: readonly Line[], queueIds: readonly string[] | null): string[] {
  if (!queueIds) return [];
  const own = queues.filter((q) => q.kind === 'provider' && queueIds.includes(q.id));
  const ids = new Set(own.map((q) => q.id));
  for (const q of own) if (q.pullsFrom) ids.add(q.pullsFrom);
  return queues.filter((q) => ids.has(q.id)).map((q) => q.id);
}

/**
 * Guests Call next on `queue` can reach: its own waiting guests plus, for a provider line, the
 * pool's (`api.call_next` falls back to the pool once the line is empty). Only enables the
 * button; the database still picks who is called.
 */
export function callableCount(
  queue: Line,
  visits: readonly Pick<ConsoleVisit, 'queueId' | 'status'>[],
): number {
  return visits.filter(
    (v) => v.status === 'waiting' && (v.queueId === queue.id || v.queueId === queue.pullsFrom),
  ).length;
}

/**
 * The visits a line's tab lists: its own, plus, for a provider line, its pool's (#80). Call next
 * on a provider line reaches the pool once the line is empty, and the guest it calls stays in the
 * pool, so without them the tab would read "No one is waiting" while guests wait and hide who was
 * just called. Order is the location's `sort_key` order; the database still picks who is called.
 */
export function lineVisits<V extends Pick<ConsoleVisit, 'queueId'>>(
  queue: Pick<Line, 'id' | 'pullsFrom'> | undefined,
  visits: readonly V[],
): V[] {
  if (!queue) return [];
  return visits.filter(
    (v) => v.queueId === queue.id || (!!queue.pullsFrom && v.queueId === queue.pullsFrom),
  );
}
