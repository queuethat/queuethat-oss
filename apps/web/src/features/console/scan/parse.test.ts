import { describe, expect, it } from 'vitest';
import { parseScanCode } from './parse.ts';

describe('parseScanCode', () => {
  it('reads the qm: payload of a guest QR', () =>
    expect(parseScanCode('qm:7K3M9PQR2T')).toBe('7K3M9PQR2T'));
  it('reads the bare printed code, ignoring case and spaces', () =>
    expect(parseScanCode(' 7k3m 9pqr2t ')).toBe('7K3M9PQR2T'));
  it('rejects other QR content', () => {
    expect(parseScanCode('https://example.com/v/abc')).toBeNull();
    expect(parseScanCode('qm:short')).toBeNull();
    expect(parseScanCode('qm:ILOU000000')).toBeNull();
    expect(parseScanCode('')).toBeNull();
  });
});
