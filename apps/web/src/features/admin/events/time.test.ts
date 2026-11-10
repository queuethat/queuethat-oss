import { describe, expect, it } from 'vitest';
import { formatRange, instantToWall, parseRange, wallToInstant } from './time.ts';

describe('wallToInstant / instantToWall', () => {
  it('reads a wall time in the location zone', () => {
    expect(wallToInstant('2030-01-12T10:00', 'Europe/Berlin')).toBe('2030-01-12T09:00:00.000Z');
    expect(wallToInstant('2030-07-12T10:00', 'Europe/Berlin')).toBe('2030-07-12T08:00:00.000Z');
    expect(wallToInstant('2030-01-12T10:00', 'America/New_York')).toBe('2030-01-12T15:00:00.000Z');
  });
  it('round-trips', () => {
    const iso = wallToInstant('2030-03-31T09:30', 'Europe/Berlin');
    expect(instantToWall(iso, 'Europe/Berlin')).toBe('2030-03-31T09:30');
  });
});

describe('ranges', () => {
  it('parses PostgREST text and formats it back', () => {
    const r = parseRange('["2030-01-12 10:00:00+00","2030-01-12 11:00:00+00")');
    expect(r).toEqual({ start: '2030-01-12T10:00:00.000Z', end: '2030-01-12T11:00:00.000Z' });
    expect(formatRange(r.start, r.end)).toBe('[2030-01-12T10:00:00.000Z,2030-01-12T11:00:00.000Z)');
  });
});
