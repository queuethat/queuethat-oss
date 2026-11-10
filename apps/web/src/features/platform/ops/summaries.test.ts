import { describe, expect, it } from 'vitest';
import type { DailyStats } from './api.ts';
import {
  cronHealth,
  dailyTotals,
  healthOf,
  lastDays,
  orgTotals,
  QUEUE_STALE_SECONDS,
} from './summaries.ts';

const row = (over: Partial<DailyStats>): DailyStats => ({
  day: '2026-10-24',
  org_id: 'org-a',
  joins: 0,
  served: 0,
  no_shows: 0,
  cancelled: 0,
  notifications_sent: 0,
  notifications_failed: 0,
  computed_at: '2026-10-25T00:15:00Z',
  ...over,
});

describe('healthOf', () => {
  it('warns on any dead notification and on a queue stuck past the threshold', () => {
    expect(healthOf({ notifications_dead: 0, oldest_queued_seconds: QUEUE_STALE_SECONDS })).toEqual(
      {
        dead: 'ok',
        queued: 'ok',
      },
    );
    expect(
      healthOf({ notifications_dead: 1, oldest_queued_seconds: QUEUE_STALE_SECONDS + 1 }),
    ).toEqual({ dead: 'warning', queued: 'warning' });
  });

  it('treats an empty queue (null age) as healthy', () => {
    expect(healthOf({ notifications_dead: 0, oldest_queued_seconds: null }).queued).toBe('ok');
  });
});

describe('cronHealth', () => {
  const job = { name: 'tick', schedule: '* * * * *', last_start: null, last_message: null };
  it('warns on a failed last run or an inactive job, not on one that has not run yet', () => {
    expect(cronHealth({ ...job, active: true, last_status: 'succeeded' })).toBe('ok');
    expect(cronHealth({ ...job, active: true, last_status: null })).toBe('ok');
    expect(cronHealth({ ...job, active: true, last_status: 'failed' })).toBe('warning');
    expect(cronHealth({ ...job, active: false, last_status: 'succeeded' })).toBe('warning');
  });
});

describe('lastDays', () => {
  it('ends on the UTC day of now, whatever the local time', () => {
    const range = lastDays(30, Date.parse('2026-10-25T23:59:00Z'));
    expect(range.to).toBe('2026-10-25');
    expect(range.from).toBe('2026-09-26');
    expect(range.days).toHaveLength(30);
    expect(lastDays(2, Date.parse('2026-03-01T00:00:00Z')).days).toEqual([
      '2026-02-28',
      '2026-03-01',
    ]);
  });
});

describe('dailyTotals', () => {
  it('sums orgs per day and fills quiet days with zeros', () => {
    const totals = dailyTotals(
      [
        row({ day: '2026-10-24', org_id: 'a', joins: 3, served: 2 }),
        row({ day: '2026-10-24', org_id: 'b', joins: 4, notifications_failed: 1 }),
        row({ day: '2026-01-01', joins: 99 }),
      ],
      ['2026-10-23', '2026-10-24'],
    );
    expect(totals.map((d) => [d.day, d.joins, d.served, d.notifications_failed])).toEqual([
      ['2026-10-23', 0, 0, 0],
      ['2026-10-24', 7, 2, 1],
    ]);
  });
});

describe('orgTotals', () => {
  it('sums each org over the range, busiest first', () => {
    const totals = orgTotals([
      row({ org_id: 'a', joins: 1 }),
      row({ org_id: 'b', joins: 5, day: '2026-10-23' }),
      row({ org_id: 'a', joins: 1, no_shows: 1, day: '2026-10-23' }),
    ]);
    expect(totals.map((o) => [o.orgId, o.joins, o.no_shows])).toEqual([
      ['b', 5, 0],
      ['a', 2, 1],
    ]);
  });
});
