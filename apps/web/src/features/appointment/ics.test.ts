import { describe, expect, it } from 'vitest';
import { appointmentIcs, appointmentUid } from './ics.ts';

describe('appointmentIcs', () => {
  const ics = appointmentIcs({
    service: 'Cut, wash; style',
    place: 'Main St',
    startsAt: '2026-10-31T13:00:00.000Z',
    endsAt: '2026-10-31T13:30:00Z',
    uid: 'abc123',
    now: new Date('2026-10-30T09:00:00Z'),
  });

  it('writes UTC times and escapes text', () => {
    expect(ics).toContain('DTSTART:20261031T130000Z');
    expect(ics).toContain('DTEND:20261031T133000Z');
    expect(ics).toContain('SUMMARY:Cut\\, wash\\; style');
  });

  it('uses CRLF line endings and carries no link token', () => {
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
    expect(ics).not.toMatch(/\/a\//);
  });

  it('keeps one UID when the appointment moves, and a newer sequence for the later file', () => {
    const moved = appointmentIcs({
      service: 'Cut, wash; style',
      place: 'Main St',
      startsAt: '2026-11-02T10:00:00Z',
      endsAt: '2026-11-02T10:30:00Z',
      uid: 'abc123',
      now: new Date('2026-10-30T10:00:00Z'),
    });
    expect(ics).toContain('UID:abc123@queuethat');
    expect(moved).toContain('UID:abc123@queuethat');
    const seq = (x: string) => Number(/SEQUENCE:(\d+)/.exec(x)![1]);
    expect(seq(moved)).toBeGreaterThan(seq(ics));
    expect(ics).toContain('DTSTAMP:20261030T090000Z');
  });

  it('derives the UID from a hash, never the token', async () => {
    const uid = await appointmentUid('secret-token-value');
    expect(uid).toMatch(/^[0-9a-f]{32}$/);
    expect(uid).not.toContain('secret');
  });
});
