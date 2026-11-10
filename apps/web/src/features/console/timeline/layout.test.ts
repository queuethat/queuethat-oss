import { describe, expect, it } from 'vitest';
import type { ConsoleVisit } from '../api.ts';
import { hourRange, localMinute, timelineEntries } from './layout.ts';

const visit = (id: string, patch: Partial<ConsoleVisit>) =>
  ({ id, scheduledAt: null, joinedAt: '2026-10-30T12:00:00Z', ...patch }) as ConsoleVisit;

describe('timeline layout', () => {
  const tz = 'Asia/Kolkata'; // UTC+5:30
  const now = Date.parse('2026-10-30T09:00:00Z'); // 14:30 there

  it('reads minutes on the location clock, not the device clock', () => {
    expect(localMinute('2026-10-30T09:00:00Z', tz)).toBe(14 * 60 + 30);
  });

  it('places appointments at their time and walk-ins at when they joined, in order', () => {
    const entries = timelineEntries(
      [
        visit('walk', { joinedAt: '2026-10-30T08:00:00Z' }),
        visit('appt', { scheduledAt: '2026-10-30T07:00:00Z', joinedAt: '2026-10-29T10:00:00Z' }),
      ],
      tz,
      now,
    );
    expect(entries.map((e) => [e.visit.id, e.minute])).toEqual([
      ['appt', 12 * 60 + 30],
      ['walk', 13 * 60 + 30],
    ]);
  });

  it('leaves out other days (by the location date)', () => {
    expect(timelineEntries([visit('old', { joinedAt: '2026-10-28T09:00:00Z' })], tz, now)).toEqual(
      [],
    );
  });

  it('draws the working day, widened for early or late entries and the current time', () => {
    expect(hourRange([], 14 * 60)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const late = timelineEntries([visit('x', { scheduledAt: '2026-10-30T16:30:00Z' })], tz, now);
    expect(hourRange(late, 14 * 60).at(-1)).toBe(22);
  });
});
