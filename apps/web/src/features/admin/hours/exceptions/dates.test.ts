import { describe, expect, it } from 'vitest';
import { dateRange, shortDate, todayIn, weekdayOf, yearAfter } from './dates.ts';

describe('exception dates', () => {
  it('AC1: 24-26 Dec is three dates, across a month end too', () => {
    expect(dateRange('2026-12-24', '2026-12-26')).toEqual([
      '2026-12-24',
      '2026-12-25',
      '2026-12-26',
    ]);
    expect(dateRange('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
  });
  it('is empty when the range is backwards and capped when huge', () => {
    expect(dateRange('2026-12-26', '2026-12-24')).toEqual([]);
    expect(dateRange('2026-01-01', '2030-01-01').length).toBeGreaterThan(366);
  });
  it('reads today in the location zone, not the browser zone', () => {
    const at = new Date('2026-12-25T02:00:00Z');
    expect(todayIn('America/New_York', at)).toBe('2026-12-24');
    expect(todayIn('Asia/Tokyo', at)).toBe('2026-12-25');
  });
  it('knows weekdays, a year ahead and short dates', () => {
    expect(weekdayOf('2026-12-25')).toBe(5);
    expect(yearAfter('2026-12-25')).toBe('2027-12-25');
    expect(shortDate('2026-12-24', 'en')).toBe('Dec 24');
  });
});
