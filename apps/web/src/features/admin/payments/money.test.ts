import { describe, expect, it } from 'vitest';
import { formatMoney, fromMinor, toMinor } from './money.ts';

describe('money', () => {
  it('reads whole and fractional amounts', () => {
    expect(toMinor('12')).toBe(1200);
    expect(toMinor('12.5')).toBe(1250);
    expect(toMinor('12,05')).toBe(1205);
  });
  it('refuses zero, negatives, junk and a third decimal', () => {
    for (const bad of ['0', '0.00', '-3', 'abc', '1.234', '', '1e3'])
      expect(toMinor(bad)).toBeNull();
  });
  it('round-trips and formats', () => {
    expect(fromMinor(1250)).toBe('12.50');
    expect(formatMoney(1250, 'usd', 'en')).toBe('$12.50');
  });
});
