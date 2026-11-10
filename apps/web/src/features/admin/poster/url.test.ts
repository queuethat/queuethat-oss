import jsQR from 'jsqr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qrPath } from './qr.ts';
import { publicJoinUrl, telegramJoinUrl } from './url.ts';

describe('publicJoinUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to VITE_PUBLIC_URL when it is set', () => {
    vi.stubEnv('VITE_PUBLIC_URL', 'https://queue.example.com');
    expect(publicJoinUrl('demo-barber')).toBe('https://queue.example.com/q/demo-barber');
  });

  it('uses the configured public URL, not the admin page origin', () => {
    expect(publicJoinUrl('demo-barber', 'https://queue.example.com')).toBe(
      'https://queue.example.com/q/demo-barber',
    );
  });

  it('ignores a path or trailing slash on the public URL: /q is at the root', () => {
    expect(publicJoinUrl('demo-barber', 'https://queue.example.com/admin/')).toBe(
      'https://queue.example.com/q/demo-barber',
    );
  });

  it('falls back to this browser origin when no public URL is set', () => {
    vi.stubEnv('VITE_PUBLIC_URL', '');
    expect(publicJoinUrl('demo-barber')).toBe(`${window.location.origin}/q/demo-barber`);
  });
});

describe('qrPath', () => {
  it('AC1: the poster code scans to the join page', () => {
    const url = 'https://queue.example.com/q/demo-barber';
    const { size, modules } = qrPath(url);
    // Render each module as a 4x4 block of pixels and decode it the way a phone camera would.
    const scale = 4;
    const width = size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        const value = modules[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
        pixels.set([value, value, value, 255], (y * width + x) * 4);
      }
    expect(jsQR(pixels, width, width)?.data).toBe(url);
  });
});

describe('telegramJoinUrl', () => {
  it('names the location alone when it has one queue', () => {
    expect(telegramJoinUrl('QueueBot', 'demo-barber', [{ sms_keyword: null }])).toBe(
      'https://t.me/QueueBot?start=demo-barber',
    );
  });

  it('adds a queue keyword when the location has several', () => {
    expect(
      telegramJoinUrl('QueueBot', 'demo-barber', [{ sms_keyword: null }, { sms_keyword: 'CUTS' }]),
    ).toBe('https://t.me/QueueBot?start=demo-barber_CUTS');
  });

  it('has no link for several queues without a keyword, or none at all', () => {
    expect(
      telegramJoinUrl('QueueBot', 'x', [{ sms_keyword: null }, { sms_keyword: null }]),
    ).toBeNull();
    expect(telegramJoinUrl('QueueBot', 'x', [])).toBeNull();
  });
});
