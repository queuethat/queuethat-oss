import { describe, expect, it } from 'vitest';
import { accessibleTextColor, contrastRatio, isHexColor, whiteTextPasses } from './contrast.ts';

describe('contrast', () => {
  it('matches the WCAG reference ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(contrastRatio('#ff0000', '#ff0000')).toBe(1);
  });
  it('picks the readable text colour and flags a 3:1 brand colour', () => {
    expect(accessibleTextColor('#0b3d91')).toBe('#ffffff');
    expect(accessibleTextColor('#ffd400')).toBe('#000000');
    expect(contrastRatio('#959595', '#ffffff')).toBeLessThan(3.1);
    expect(whiteTextPasses('#959595')).toBe(false);
    expect(accessibleTextColor('#959595')).toBe('#000000');
    expect(whiteTextPasses('#0b3d91')).toBe(true);
  });
  it('accepts only #rrggbb', () => {
    expect(isHexColor('#AbCdEf')).toBe(true);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('#fff')).toBe(false);
  });
});
