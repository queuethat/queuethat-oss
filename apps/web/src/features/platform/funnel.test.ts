import { describe, expect, it } from 'vitest';
import { barWidth, isDay, parseFunnelSearch, percent } from './funnel.ts';

describe('parseFunnelSearch', () => {
  it('keeps what the page writes', () => {
    expect(
      parseFunnelSearch({ from: '2026-01-01', to: '2026-01-31', stage: 'line_live', page: 2 }),
    ).toEqual({ from: '2026-01-01', to: '2026-01-31', stage: 'line_live', page: 2 });
  });

  it('opens the default funnel for an empty or hand-edited address', () => {
    expect(parseFunnelSearch({})).toEqual({});
    expect(
      parseFunnelSearch({ from: 'yesterday', to: '2026-02-31', stage: 'first_served', page: -1 }),
    ).toEqual({});
    expect(parseFunnelSearch({ stage: ['line_live'], page: 'x', from: 5 })).toEqual({});
  });

  it('drops a reversed range as a whole and a page that is not a whole number', () => {
    expect(parseFunnelSearch({ from: '2026-03-02', to: '2026-03-01' })).toEqual({});
    expect(parseFunnelSearch({ from: '2026-03-01', to: '2026-03-01' })).toEqual({
      from: '2026-03-01',
      to: '2026-03-01',
    });
    expect(parseFunnelSearch({ page: 1.5 })).toEqual({});
    expect(parseFunnelSearch({ page: 0 })).toEqual({});
    expect(parseFunnelSearch({ page: 100000 })).toEqual({});
  });

  it('accepts a range with only one end', () => {
    expect(parseFunnelSearch({ to: '2026-03-01' })).toEqual({ to: '2026-03-01' });
  });
});

describe('isDay', () => {
  it('accepts real days, leap day included, and nothing else', () => {
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2026-2-1')).toBe(false);
    expect(isDay(20260201)).toBe(false);
  });
});

describe('percent and barWidth', () => {
  it('formats a ratio, and shows a dash when there was no base', () => {
    expect(percent(0.6667, 'en')).toBe('67%');
    expect(percent(0, 'en')).toBe('0%');
    expect(percent(1, 'en')).toBe('100%');
    expect(percent(null, 'en')).toBe('–');
  });

  it('scales to the widest stage and never hides a stage that was reached', () => {
    expect(barWidth(10, 10)).toBe('100%');
    expect(barWidth(5, 10)).toBe('50%');
    expect(barWidth(1, 1000)).toBe('2%');
    expect(barWidth(0, 10)).toBe('0%');
    expect(barWidth(0, 0)).toBe('0%');
  });
});
