import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldIcsLine } from './ics.ts';

const base = {
  uid: '7K2M9P4X1Q@queue-management',
  durationMinutes: 30,
  summary: 'Haircut at Demo Barber',
  stamp: '2026-10-30T10:00:00Z',
};

describe('buildIcs', () => {
  it('writes DTSTART in UTC from the instant (AC1: 14:30 Berlin is 13:30Z in November)', () => {
    const ics = buildIcs({ ...base, start: '2026-11-03T14:30:00+01:00' });
    expect(ics).toContain('DTSTART:20261103T133000Z\r\n');
    expect(ics).toContain('DTEND:20261103T140000Z\r\n');
  });

  it('keeps the UTC instant across daylight saving (14:30 Berlin in July is 12:30Z)', () => {
    const ics = buildIcs({ ...base, start: '2026-07-03T14:30:00+02:00' });
    expect(ics).toContain('DTSTART:20260703T123000Z\r\n');
  });

  it('is a CRLF VCALENDAR with one VEVENT and a stable uid', () => {
    const ics = buildIcs({ ...base, start: '2026-11-03T13:30:00Z' });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('UID:7K2M9P4X1Q@queue-management\r\n');
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('adds a reminder only when asked', () => {
    const none = buildIcs({ ...base, start: '2026-11-03T13:30:00Z' });
    const alarm = buildIcs({ ...base, start: '2026-11-03T13:30:00Z', alarmMinutes: 15 });
    expect(none).not.toContain('VALARM');
    expect(alarm).toContain('TRIGGER:-PT15M');
  });

  it('puts the place in the file and rejects a bad date', () => {
    const ics = buildIcs({ ...base, start: '2026-11-03T13:30:00Z', location: 'Main St 1, Berlin' });
    expect(ics).toContain('LOCATION:Main St 1\\, Berlin');
    expect(() => buildIcs({ ...base, start: 'soon' })).toThrow(RangeError);
  });
});

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma and newline', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe(String.raw`a\\b\;c\,d\ne`);
  });
});

describe('foldIcsLine', () => {
  it('leaves short lines alone', () => {
    expect(foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds at 75 octets without splitting a multi-byte character', () => {
    const line = 'DESCRIPTION:' + 'é'.repeat(60);
    const folded = foldIcsLine(line);
    for (const part of folded.split('\r\n')) {
      // 'é' is two octets, the space a continuation adds is one.
      const octets = [...part].reduce((n, ch) => n + (ch === 'é' ? 2 : 1), 0);
      expect(octets).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});
