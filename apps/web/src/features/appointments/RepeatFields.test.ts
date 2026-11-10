import { describe, expect, it } from 'vitest';
import { NO_REPEAT, repeatReady } from './RepeatFields.tsx';

describe('repeatReady', () => {
  it('accepts a single booking', () => {
    expect(repeatReady(NO_REPEAT)).toBe(true);
  });
  it('needs at least two bookings or an end date', () => {
    expect(repeatReady({ ...NO_REPEAT, repeat: true, count: 1 })).toBe(false);
    expect(repeatReady({ ...NO_REPEAT, repeat: true, count: 4 })).toBe(true);
    expect(repeatReady({ ...NO_REPEAT, repeat: true, endsBy: 'until', until: '' })).toBe(false);
    expect(repeatReady({ ...NO_REPEAT, repeat: true, endsBy: 'until', until: '2030-01-01' })).toBe(
      true,
    );
  });
  it('keeps the interval between 1 and 8 weeks', () => {
    expect(repeatReady({ ...NO_REPEAT, repeat: true, intervalWeeks: 0 })).toBe(false);
    expect(repeatReady({ ...NO_REPEAT, repeat: true, intervalWeeks: 9 })).toBe(false);
  });
});
