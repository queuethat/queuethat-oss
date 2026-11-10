import { describe, expect, it } from 'vitest';
import { clockTime, crossesMidnight, intervalEnds, weekdayName } from './summary.ts';

describe('hours summary', () => {
  it('AC1: Friday 18:00-02:00 reads Fri 6 pm to Sat 2 am', () => {
    expect(intervalEnds(5, '18:00', '02:00', 'en')).toEqual({ from: 'Fri 6 pm', to: 'Sat 2 am' });
  });
  it('wraps Saturday into Sunday', () => {
    expect(intervalEnds(6, '23:00', '03:00', 'en').to).toBe('Sun 3 am');
  });
  it('names no second day within one day, and shows minutes only when needed', () => {
    expect(intervalEnds(1, '09:00', '17:30', 'en')).toEqual({ from: 'Mon 9 am', to: '5:30 pm' });
  });
  it('flags cross-midnight intervals only', () => {
    expect(crossesMidnight('18:00', '02:00')).toBe(true);
    expect(crossesMidnight('09:00', '17:00')).toBe(false);
  });
  it('follows the locale', () => {
    expect(weekdayName(0, 'en')).toBe('Sunday');
    expect(clockTime('18:00', 'de')).toBe('18 Uhr');
  });
});
