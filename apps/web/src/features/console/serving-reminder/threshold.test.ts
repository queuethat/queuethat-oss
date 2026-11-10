import { describe, expect, it } from 'vitest';
import { overdueVisits, reminderThreshold } from './threshold.ts';

describe('reminderThreshold', () => {
  it('uses the queue setting when present', () => expect(reminderThreshold(30, 10)).toBe(30));
  it('doubles the expected minutes', () => expect(reminderThreshold(null, 20)).toBe(40));
  it('never goes below 15', () => expect(reminderThreshold(null, 5)).toBe(15));
  it('assumes 10 expected minutes without a service', () =>
    expect(reminderThreshold(null, null)).toBe(20));
});

describe('overdueVisits', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const ago = (m: number) => new Date(now - m * 60_000).toISOString();
  const v = (id: string, since: string, status = 'serving') => ({
    id,
    status,
    since,
    queueId: 'q',
    expectedMinutes: 10,
  });
  const none = () => null;

  it('flags a 10-minute service started 21 minutes ago', () =>
    expect(overdueVisits([v('a', ago(21))], none, now, {})).toEqual([{ id: 'a', minutes: 21 }]));
  it('skips a visit under the threshold', () =>
    expect(overdueVisits([v('a', ago(19))], none, now, {})).toEqual([]));
  it('skips visits that are not being served', () =>
    expect(overdueVisits([v('a', ago(60), 'called')], none, now, {})).toEqual([]));
  it('hides a snoozed visit until the snooze ends', () => {
    expect(overdueVisits([v('a', ago(60))], none, now, { a: now + 1 })).toEqual([]);
    expect(overdueVisits([v('a', ago(60))], none, now, { a: now })).toHaveLength(1);
  });
  it('honours the queue setting', () =>
    expect(overdueVisits([v('a', ago(21))], () => 30, now, {})).toEqual([]));
});
