import { describe, expect, it } from 'vitest';
import { overlapsAny, type Range } from './overlap.ts';

const r = (
  starts: string,
  ends: string,
  validFrom: string | null = null,
  validTo: string | null = null,
): Range => ({
  starts,
  ends,
  validFrom,
  validTo,
});

describe('overlapsAny', () => {
  it('allows ranges that only touch', () => {
    expect(overlapsAny(r('13:00', '17:00'), [r('09:00', '13:00')])).toBe(false);
  });

  it('rejects ranges that share time', () => {
    expect(overlapsAny(r('12:00', '14:00'), [r('09:00', '13:00')])).toBe(true);
  });

  it('treats an end at or before the start as after midnight', () => {
    expect(overlapsAny(r('23:00', '01:00'), [r('22:00', '23:30')])).toBe(true);
    expect(overlapsAny(r('23:00', '01:00'), [r('09:00', '12:00')])).toBe(false);
  });

  it('lets the same hours coexist in different date windows', () => {
    expect(
      overlapsAny(r('09:00', '13:00', '2026-12-01'), [r('09:00', '13:00', null, '2026-11-30')]),
    ).toBe(false);
    expect(
      overlapsAny(r('09:00', '13:00', '2026-11-30'), [r('09:00', '13:00', null, '2026-11-30')]),
    ).toBe(true);
  });
});
