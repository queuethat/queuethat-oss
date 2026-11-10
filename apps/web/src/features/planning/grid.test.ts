import { describe, expect, it } from 'vitest';
import {
  conflictsIn,
  parseRange,
  rowForAppointment,
  rowForShift,
  spanOnDay,
  UNASSIGNED,
  zonedInstant,
  type ResourceLike,
} from './grid.ts';

const tz = 'America/New_York';
const resources: ResourceLike[] = [
  { id: 'chair', kind: 'chair', member_user_id: null },
  { id: 'ann', kind: 'staff', member_user_id: 'u-ann' },
];

describe('spanOnDay', () => {
  it('places an hour at 10:00 local time (not UTC) as a fraction of the 07:00-21:00 window', () => {
    // 10:00 New York in December is 15:00Z.
    const s = spanOnDay('2026-12-21T15:00:00Z', '2026-12-21T16:00:00Z', tz, '2026-12-21')!;
    expect(s.left).toBeCloseTo(3 / 14);
    expect(s.width).toBeCloseTo(1 / 14);
  });
  it('clips to the window and drops what falls outside it or on another day', () => {
    const s = spanOnDay('2026-12-21T10:00:00Z', '2026-12-21T13:00:00Z', tz, '2026-12-21')!;
    expect(s.left).toBe(0);
    expect(s.width).toBeCloseTo(1 / 14);
    expect(spanOnDay('2026-12-22T15:00:00Z', '2026-12-22T16:00:00Z', tz, '2026-12-21')).toBeNull();
    expect(spanOnDay('2026-12-22T03:00:00Z', '2026-12-22T04:00:00Z', tz, '2026-12-21')).toBeNull();
  });
});

describe('rows', () => {
  it('puts an appointment on its staff resource, else a mapped resource, else unassigned', () => {
    const map = [{ service_id: 's1', counter_id: 'chair' }];
    expect(rowForAppointment({ staff_user_id: 'u-ann', service_id: 's1' }, resources, map)).toBe(
      'ann',
    );
    expect(rowForAppointment({ staff_user_id: null, service_id: 's1' }, resources, map)).toBe(
      'chair',
    );
    expect(rowForAppointment({ staff_user_id: null, service_id: 's2' }, resources, map)).toBe(
      UNASSIGNED,
    );
  });
  it('puts a shift on its counter, else its person, else nowhere', () => {
    expect(rowForShift({ counter_id: 'chair', user_id: 'x' }, resources)).toBe('chair');
    expect(rowForShift({ counter_id: null, user_id: 'u-ann' }, resources)).toBe('ann');
    expect(rowForShift({ counter_id: null, user_id: 'x' }, resources)).toBeNull();
  });
});

describe('parseRange', () => {
  it('reads PostgREST tstzrange text', () => {
    expect(parseRange('["2026-12-21 15:10:00+00","2026-12-21 16:00:00+00")')).toEqual({
      start: '2026-12-21T15:10:00+00:00',
      end: '2026-12-21T16:00:00+00:00',
    });
    expect(parseRange('nonsense')).toBeNull();
  });
});

describe('zonedInstant', () => {
  it('turns a local wall time into the right instant, winter and summer', () => {
    expect(zonedInstant('2026-12-21', 10 * 60, tz).toISOString()).toBe('2026-12-21T15:00:00.000Z');
    expect(zonedInstant('2026-07-21', 10 * 60, tz).toISOString()).toBe('2026-07-21T14:00:00.000Z');
  });
});

describe('conflictsIn', () => {
  const appt = (id: string, from: string, to: string) => ({
    id,
    starts_at: from,
    ends_at: to,
    staff_user_id: 'u-ann',
    service_id: 's1',
  });
  it('lists bookings in the selected rows that overlap the range', () => {
    const range = {
      start: new Date('2026-12-21T15:00:00Z'),
      end: new Date('2026-12-21T16:00:00Z'),
    };
    const list = [
      appt('in', '2026-12-21T15:30:00Z', '2026-12-21T16:30:00Z'),
      appt('touching', '2026-12-21T16:00:00Z', '2026-12-21T17:00:00Z'),
    ];
    expect(conflictsIn(list, new Set(['ann']), range, resources, []).map((a) => a.id)).toEqual([
      'in',
    ]);
    expect(conflictsIn(list, new Set(['chair']), range, resources, [])).toEqual([]);
  });
});
