import { describe, expect, it } from 'vitest';
import { smsSegments } from './sms-segments.ts';

describe('smsSegments', () => {
  it.each([
    ['empty', '', 'gsm7', 0, 0],
    ['160 GSM-7 characters', 'a'.repeat(160), 'gsm7', 160, 1],
    ['161 GSM-7 characters', 'a'.repeat(161), 'gsm7', 161, 2],
    ['306 GSM-7 characters', 'a'.repeat(306), 'gsm7', 306, 2],
    ['307 GSM-7 characters', 'a'.repeat(307), 'gsm7', 307, 3],
    ['accented GSM-7 letters', 'é'.repeat(160), 'gsm7', 160, 1],
    ['extension characters count double', '{'.repeat(80), 'gsm7', 160, 1],
    ['one extension character over the limit', 'a'.repeat(159) + '€', 'gsm7', 161, 2],
    ['69 characters and an emoji (70 units)', 'a'.repeat(68) + '😀', 'ucs2', 70, 1],
    ['70 characters and an emoji (71 units)', 'a'.repeat(69) + '😀', 'ucs2', 71, 2],
    ['a non-GSM letter forces UCS-2', 'ç' + 'a'.repeat(69), 'ucs2', 70, 1],
    ['134 UCS-2 units', 'ç'.repeat(134), 'ucs2', 134, 2],
    ['135 UCS-2 units', 'ç'.repeat(135), 'ucs2', 135, 3],
  ])('%s', (_, text, encoding, chars, segments) => {
    expect(smsSegments(text)).toEqual({ encoding, chars, segments });
  });
});
