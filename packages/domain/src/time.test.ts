import { describe, expect, it } from 'vitest';
import {
  atLocalTime,
  formatLocalTime,
  fromLocalDateTime,
  localDateTimeValue,
  localTimeValue,
} from './time.ts';

describe('formatLocalTime', () => {
  const at = '2026-10-25T14:30:00Z';

  // Two zones 12.5 h apart, so at least one differs from whatever zone the runner uses.
  it('shows the location time, not the device time', () => {
    expect(formatLocalTime(at, 'Asia/Kolkata', 'en-US')).toBe('8:00 PM');
    expect(formatLocalTime(at, 'America/Los_Angeles', 'en-US')).toBe('7:30 AM');
  });

  it('accepts a Date', () => {
    expect(formatLocalTime(new Date(at), 'UTC', 'en-GB')).toBe('14:30');
  });
});

describe('localTimeValue and atLocalTime', () => {
  it('read and write the location wall clock', () => {
    const at = '2026-10-25T14:30:00Z';
    expect(localTimeValue(at, 'Asia/Kolkata')).toBe('20:00');
    expect(localTimeValue(at, 'America/Los_Angeles')).toBe('07:30');
  });

  it('puts a wall time on the same local day as the original', () => {
    // 04:30 UTC on the 26th is still the 25th in Los Angeles.
    const original = '2026-10-26T04:30:00Z';
    expect(atLocalTime('09:15', original, 'America/Los_Angeles').toISOString()).toBe(
      '2026-10-25T16:15:00.000Z',
    );
    expect(atLocalTime('20:00', '2026-10-25T14:30:00Z', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-25T14:30:00.000Z',
    );
  });

  it('round-trips across a daylight-saving change', () => {
    const day = '2026-11-01T20:00:00Z'; // US fall-back day
    for (const hhmm of ['00:30', '03:00', '12:00', '23:45']) {
      expect(
        localTimeValue(atLocalTime(hhmm, day, 'America/Los_Angeles'), 'America/Los_Angeles'),
      ).toBe(hhmm);
    }
  });
});

describe('localDateTimeValue / fromLocalDateTime', () => {
  it('reads and writes the location wall clock, whatever the device zone', () => {
    expect(localDateTimeValue('2026-10-25T14:30:00Z', 'Asia/Kolkata')).toBe('2026-10-25T20:00');
    expect(fromLocalDateTime('2026-10-25T20:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-25T14:30:00.000Z',
    );
    expect(fromLocalDateTime('2026-07-01T09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
  });

  it('round-trips across the date line', () => {
    const iso = '2026-12-31T23:30:00.000Z';
    const v = localDateTimeValue(iso, 'Pacific/Kiritimati');
    expect(v).toBe('2027-01-01T13:30');
    expect(fromLocalDateTime(v, 'Pacific/Kiritimati').toISOString()).toBe(iso);
  });
});
