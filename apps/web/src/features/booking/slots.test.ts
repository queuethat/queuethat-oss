import { describe, expect, it } from 'vitest';
import { addDays, formatTime, groupByDay, localDate, zoneName } from './slots.ts';

const slot = (iso: string) => ({ slot_start: iso, slot_end: iso, remaining: 1 });

describe('booking slot helpers', () => {
  it('reads an instant on the wall clock of the location, not the browser', () => {
    // 23:30 UTC on 30 Oct is already 31 Oct 00:30 in Berlin (CET, after the 25 Oct switch).
    expect(localDate('2026-10-30T23:30:00Z', 'Europe/Berlin')).toBe('2026-10-31');
    expect(localDate('2026-10-30T23:30:00Z', 'America/New_York')).toBe('2026-10-30');
    expect(formatTime('2026-10-31T13:00:00Z', 'Europe/Berlin', 'en')).toBe('2:00 PM');
  });

  it('labels the zone it shows times in', () => {
    expect(zoneName('2026-10-31T13:00:00Z', 'Europe/Berlin', 'en')).toBe(
      'Central European Standard Time',
    );
  });

  it('groups slots by local day in time order', () => {
    const days = groupByDay(
      [slot('2026-10-31T15:00:00Z'), slot('2026-10-30T23:30:00Z'), slot('2026-10-31T09:00:00Z')],
      'Europe/Berlin',
    );
    expect([...days.keys()]).toEqual(['2026-10-31']);
    expect(days.get('2026-10-31')?.map((s) => s.slot_start)).toEqual([
      '2026-10-30T23:30:00Z',
      '2026-10-31T09:00:00Z',
      '2026-10-31T15:00:00Z',
    ]);
  });

  it('adds calendar days across a month end', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});
