import { describe, expect, it } from 'vitest';
import { laterSlots } from './joinLater.ts';

describe('laterSlots', () => {
  it('offers quarter hours from 15 minutes ahead up to the window', () => {
    const slots = laterSlots(new Date('2026-10-30T10:07:00Z'), 1, 'UTC');
    expect(slots.map((s) => s.toISOString().slice(11, 16))).toEqual(['10:30', '10:45', '11:00']);
  });

  it('stops at the end of the day at the location', () => {
    // 22:40 in Berlin (UTC+1 in winter): midnight is 80 minutes away.
    const slots = laterSlots(new Date('2026-12-01T21:40:00Z'), 4, 'Europe/Berlin');
    expect(slots.at(-1)?.toISOString()).toBe('2026-12-01T22:45:00.000Z');
  });

  it('is empty when nothing fits today', () => {
    expect(laterSlots(new Date('2026-12-01T22:50:00Z'), 4, 'Europe/Berlin')).toEqual([]);
  });
});
