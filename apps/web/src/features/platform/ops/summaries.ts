import type { CronJob, DailyStats, PlatformHealth } from './api.ts';

/** A queued notification older than this means the dispatcher is stuck or falling behind. */
export const QUEUE_STALE_SECONDS = 5 * 60;

export type Health = 'ok' | 'warning';

/** How each health tile looks: any dead notification or failed cron run is worth a look. */
export function healthOf(
  health: Pick<PlatformHealth, 'notifications_dead' | 'oldest_queued_seconds'>,
) {
  return {
    dead: (health.notifications_dead ?? 0) > 0 ? 'warning' : 'ok',
    queued: (health.oldest_queued_seconds ?? 0) > QUEUE_STALE_SECONDS ? 'warning' : 'ok',
  } satisfies Record<string, Health>;
}

export function cronHealth(job: CronJob): Health {
  return job.active && job.last_status !== 'failed' ? 'ok' : 'warning';
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last `days` UTC days up to and including today, as `api.platform_stats` takes them. */
export function lastDays(days: number, now: number): { from: string; to: string; days: string[] } {
  const today = Date.parse(isoDay(now));
  const list = Array.from({ length: days }, (_, i) => isoDay(today - (days - 1 - i) * DAY_MS));
  return { from: list[0]!, to: list[days - 1]!, days: list };
}

export type Counts = Pick<
  DailyStats,
  'joins' | 'served' | 'no_shows' | 'cancelled' | 'notifications_sent' | 'notifications_failed'
>;

const zero = (): Counts => ({
  joins: 0,
  served: 0,
  no_shows: 0,
  cancelled: 0,
  notifications_sent: 0,
  notifications_failed: 0,
});

function add(into: Counts, row: Counts) {
  for (const key of Object.keys(into) as (keyof Counts)[]) into[key] += row[key];
}

/** Platform totals per day, with a zero row for days nothing happened. */
export function dailyTotals(rows: readonly DailyStats[], days: readonly string[]) {
  const byDay = new Map(days.map((day) => [day, zero()]));
  for (const row of rows) {
    const day = byDay.get(row.day);
    if (day) add(day, row);
  }
  return days.map((day) => ({ day, ...byDay.get(day)! }));
}

/** Totals per org over the whole range, busiest first. */
export function orgTotals(rows: readonly DailyStats[]) {
  const byOrg = new Map<string, Counts>();
  for (const row of rows) {
    const org = byOrg.get(row.org_id) ?? zero();
    add(org, row);
    byOrg.set(row.org_id, org);
  }
  return [...byOrg]
    .map(([orgId, counts]) => ({ orgId, ...counts }))
    .sort((a, b) => b.joins - a.joins || a.orgId.localeCompare(b.orgId));
}
