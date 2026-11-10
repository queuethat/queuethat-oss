import { describe, expect, it } from 'vitest';
import { parsePosition } from './api.ts';

describe('parsePosition', () => {
  it('is null when both are blank', () => expect(parsePosition('', ' ')).toBeNull());
  it('parses a pair in range', () =>
    expect(parsePosition('51.5', '-0.1')).toEqual({ lat: 51.5, lng: -0.1 }));
  it.each([
    ['51.5', ''],
    ['', '1'],
    ['91', '0'],
    ['0', '181'],
    ['abc', '0'],
  ])('rejects %s, %s', (lat, lng) => expect(parsePosition(lat, lng)).toBeUndefined());
});
