import { describe, expect, it } from 'vitest';
import { countdown, deviceStatus, isConnecting, OFFLINE_AFTER_MS, relativeAgo } from './status.ts';

const now = Date.parse('2026-10-25T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('deviceStatus', () => {
  it('is online while heartbeats are recent', () => {
    expect(deviceStatus(ago(OFFLINE_AFTER_MS - 1000), now)).toEqual({
      online: true,
      agoMs: OFFLINE_AFTER_MS - 1000,
    });
  });

  it('AC1: is offline once a screen has not been seen for 5 minutes', () => {
    expect(deviceStatus(ago(OFFLINE_AFTER_MS), now).online).toBe(false);
  });

  it('is offline when a screen never sent a heartbeat', () => {
    expect(deviceStatus(null, now)).toEqual({ online: false, agoMs: undefined });
  });

  it('treats a heartbeat from a clock slightly ahead as just now', () => {
    expect(deviceStatus(ago(-5000), now)).toEqual({ online: true, agoMs: 0 });
  });
});

describe('isConnecting', () => {
  it('is a new screen that has not checked in yet', () => {
    expect(isConnecting({ last_seen_at: null, created_at: ago(10_000) }, now)).toBe(true);
  });

  it('stops once the screen checks in, or after 5 minutes without a heartbeat', () => {
    expect(isConnecting({ last_seen_at: ago(1000), created_at: ago(10_000) }, now)).toBe(false);
    expect(isConnecting({ last_seen_at: null, created_at: ago(OFFLINE_AFTER_MS) }, now)).toBe(
      false,
    );
  });
});

describe('relativeAgo', () => {
  it('uses the largest whole unit', () => {
    expect(relativeAgo(30_000)).toEqual({ value: -0, unit: 'minute' });
    expect(relativeAgo(59 * 60_000)).toEqual({ value: -59, unit: 'minute' });
    expect(relativeAgo(3 * 3600_000)).toEqual({ value: -3, unit: 'hour' });
    expect(relativeAgo(50 * 3600_000)).toEqual({ value: -2, unit: 'day' });
  });
});

describe('countdown', () => {
  it('shows minutes and seconds left, then null', () => {
    expect(countdown(new Date(now + 600_000).toISOString(), now)).toBe('10:00');
    expect(countdown(new Date(now + 61_500).toISOString(), now)).toBe('1:02');
    expect(countdown(new Date(now).toISOString(), now)).toBeNull();
  });
});
