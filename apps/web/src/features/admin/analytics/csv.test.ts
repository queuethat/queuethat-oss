import { describe, expect, it } from 'vitest';
import type { AnalyticsRow } from './api.ts';
import { isoDay, joinsByHour, toCsv } from './csv.ts';

const row = (label: string, joined: number): AnalyticsRow => ({
  key: label,
  label,
  joined,
  served: 1,
  p50WaitMin: null,
  p90WaitMin: 9,
  abandonment: 0.25,
  noShow: null,
});

describe('analytics csv', () => {
  it('writes a header, empty cells for nulls and quotes commas', () => {
    expect(toCsv(['A', 'B,C'], [row('x', 3)])).toBe('A,"B,C"\r\nx,3,1,,9,0.25,\r\n');
  });
  it('sums joins by local hour', () => {
    const h = joinsByHour([row('2026-10-01 09:00', 2), row('2026-10-02 09:00', 3)]);
    expect(h[9]).toBe(5);
    expect(h[10]).toBe(0);
  });
  it('counts days back from today', () => {
    expect(isoDay(30, new Date(2026, 9, 30))).toBe('2026-09-30');
  });
});
