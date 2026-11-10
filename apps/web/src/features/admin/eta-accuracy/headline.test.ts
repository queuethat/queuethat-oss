import { describe, expect, it } from 'vitest';
import type { EtaAccuracyRow } from './api.ts';
import { headline } from './headline.ts';

const row = (visits: number, withinPct: number, latePct: number, avgLateMin: number | null) =>
  ({ group: 'd', visits, withinPct, latePct, avgLateMin }) as EtaAccuracyRow;

describe('headline', () => {
  it('weights each day by its quoted visits', () => {
    expect(headline([row(10, 80, 20, 6), row(30, 40, 60, 10)])).toEqual({
      withinPct: 50,
      avgLateMin: 10,
    });
  });
  it('is null with no quoted visits and has no late figure when nobody was late', () => {
    expect(headline([])).toBeNull();
    expect(headline([row(4, 100, 0, null)])).toEqual({ withinPct: 100, avgLateMin: null });
  });
});
