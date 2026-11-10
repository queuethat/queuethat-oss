import { describe, expect, it } from 'vitest';
import { presetRange, validRange } from './range.ts';

describe('presetRange', () => {
  const custom = { from: '2027-01-01', to: '2027-01-05' };
  it('counts forward from today', () => {
    expect(presetRange('30', '2026-12-15', custom)).toEqual({
      from: '2026-12-15',
      to: '2027-01-14',
    });
    expect(presetRange('90', '2026-10-31', custom)).toEqual({
      from: '2026-10-31',
      to: '2027-01-29',
    });
  });
  it('uses the typed dates for custom', () => {
    expect(presetRange('custom', '2026-12-15', custom)).toEqual(custom);
  });
});

describe('validRange', () => {
  it('rejects empty, reversed and over-long ranges', () => {
    expect(validRange({ from: '', to: '2027-01-01' })).toBe(false);
    expect(validRange({ from: '2027-01-02', to: '2027-01-01' })).toBe(false);
    expect(validRange({ from: '2027-01-01', to: '2028-06-01' })).toBe(false);
    expect(validRange({ from: '2027-01-01', to: '2027-03-01' })).toBe(true);
  });
});
