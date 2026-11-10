import { describe, expect, it } from 'vitest';
import { statusUrl } from './slipUrl.ts';

describe('statusUrl', () => {
  it('points the QR at the guest status page', () => {
    expect(statusUrl('https://shop.example', 'abc123')).toBe('https://shop.example/v/abc123');
  });
  it('is null when no link token exists, so no QR is printed', () => {
    expect(statusUrl('https://shop.example', null)).toBeNull();
    expect(statusUrl('https://shop.example', '')).toBeNull();
  });
});
