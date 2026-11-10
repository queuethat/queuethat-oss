/** Never nudge sooner than this, whatever the service or the queue says (the database floor). */
export const MIN_REMINDER_MINUTES = 15;
/** Used when a visit has no service to take an expected duration from. */
const DEFAULT_EXPECTED_MINUTES = 10;
/** "Still serving" hides the reminder for this long, on this tablet only. */
export const SNOOZE_MS = 15 * 60_000;

/**
 * Minutes into service after which staff are reminded: the queue's own setting when it has
 * one, otherwise twice the service's expected minutes, and never below 15.
 */
export function reminderThreshold(
  queueMinutes: number | null,
  expectedMinutes: number | null,
): number {
  const base = queueMinutes ?? 2 * (expectedMinutes ?? DEFAULT_EXPECTED_MINUTES);
  return Math.max(MIN_REMINDER_MINUTES, base);
}

export interface Overdue {
  id: string;
  minutes: number;
}

/**
 * Serving visits past their threshold at `now` (server time, ms) and not snoozed. `snoozedUntil`
 * maps visit id to the ms timestamp until which this tablet hides its reminder.
 */
export function overdueVisits(
  visits: {
    id: string;
    status: string;
    since: string;
    queueId: string;
    expectedMinutes: number | null;
  }[],
  queueMinutes: (queueId: string) => number | null,
  now: number,
  snoozedUntil: Record<string, number>,
): Overdue[] {
  const out: Overdue[] = [];
  for (const v of visits) {
    if (v.status !== 'serving') continue;
    const minutes = Math.floor((now - new Date(v.since).getTime()) / 60_000);
    if (minutes < reminderThreshold(queueMinutes(v.queueId), v.expectedMinutes)) continue;
    if ((snoozedUntil[v.id] ?? 0) > now) continue;
    out.push({ id: v.id, minutes });
  }
  return out;
}
