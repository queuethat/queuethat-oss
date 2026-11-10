import { afterEach, describe, expect, it } from 'vitest';
import {
  auditFilters,
  auditPageLinks,
  isCalendarDay,
  parseAuditSearch,
  rangeInstants,
  rangeInverted,
} from './search.ts';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('parseAuditSearch', () => {
  it('keeps good filters and lower-cases ids', () => {
    expect(
      parseAuditSearch({
        actor: ID.toUpperCase(),
        org: ID,
        action: 'support.',
        from: '2026-10-01',
        to: '2026-10-31',
        after: '120',
        before: '200,150',
      }),
    ).toEqual({
      actor: ID,
      org: ID,
      action: 'support.',
      from: '2026-10-01',
      to: '2026-10-31',
      after: '120',
      before: '200,150',
    });
  });

  it('drops anything the page did not write, so a stale link opens page one', () => {
    expect(
      parseAuditSearch({
        actor: 'agent-x',
        org: '123',
        action: 'DROP TABLE',
        from: '2026-02-30',
        to: '10/31/2026',
        after: '0',
        before: '1',
      }),
    ).toEqual({});
    expect(parseAuditSearch({ after: 'abc', before: '5' })).toEqual({});
    expect(parseAuditSearch({ after: '99999999999999999999' })).toEqual({});
    expect(parseAuditSearch({ actor: 42, org: null, action: ['org.suspend'] })).toEqual({});
  });

  it('accepts cursors the router parsed into numbers', () => {
    expect(parseAuditSearch({ after: 950, before: 1200 })).toEqual({
      after: '950',
      before: '1200',
    });
    expect(parseAuditSearch({ after: 1.5 })).toEqual({});
    expect(parseAuditSearch({ after: -3 })).toEqual({});
  });

  it('drops the trail without a cursor and caps it at 20 pages', () => {
    expect(parseAuditSearch({ before: '5,4' })).toEqual({});
    const trail = Array.from({ length: 30 }, (_, i) => String(i + 1)).join(',');
    const parsed = parseAuditSearch({ after: '99', before: trail });
    expect(parsed.before?.split(',')).toHaveLength(20);
    expect(parsed.before?.endsWith('30')).toBe(true);
  });

  it('trims whitespace and refuses an overlong action', () => {
    expect(parseAuditSearch({ action: ' org.suspend ' })).toEqual({ action: 'org.suspend' });
    expect(parseAuditSearch({ action: `a.${'b'.repeat(80)}` })).toEqual({});
  });
});

describe('isCalendarDay / rangeInverted', () => {
  it('accepts real days only', () => {
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('2026-1-1')).toBe(false);
  });

  it('flags an inverted range, not a one-day or open one', () => {
    expect(rangeInverted({ from: '2026-10-02', to: '2026-10-01' })).toBe(true);
    expect(rangeInverted({ from: '2026-10-01', to: '2026-10-01' })).toBe(false);
    expect(rangeInverted({ from: '2026-10-01' })).toBe(false);
    expect(rangeInverted({})).toBe(false);
  });
});

describe('rangeInstants', () => {
  it('is empty for an open range', () => {
    expect(rangeInstants({})).toEqual({});
  });

  it('covers whole local days: start of the first, start of the day after the last', () => {
    process.env.TZ = 'America/Winnipeg';
    expect(rangeInstants({ from: '2026-10-01', to: '2026-10-01' })).toEqual({
      from: '2026-10-01T05:00:00.000Z',
      to: '2026-10-02T05:00:00.000Z',
    });
  });

  it('a day with 25 hours (clocks go back) still ends at the next local midnight', () => {
    process.env.TZ = 'America/Winnipeg';
    const { from, to } = rangeInstants({ from: '2025-11-02', to: '2025-11-02' });
    expect(from).toBe('2025-11-02T05:00:00.000Z');
    expect(to).toBe('2025-11-03T06:00:00.000Z');
  });

  it('a day with 23 hours (clocks go forward) still ends at the next local midnight', () => {
    process.env.TZ = 'America/Winnipeg';
    const { from, to } = rangeInstants({ from: '2025-03-09', to: '2025-03-09' });
    expect(from).toBe('2025-03-09T06:00:00.000Z');
    expect(to).toBe('2025-03-10T05:00:00.000Z');
  });

  it('a month-end and year-end last day rolls over', () => {
    process.env.TZ = 'UTC';
    expect(rangeInstants({ to: '2026-12-31' }).to).toBe('2027-01-01T00:00:00.000Z');
    expect(rangeInstants({ to: '2026-02-28' }).to).toBe('2026-03-01T00:00:00.000Z');
  });

  it('the same days are different instants in different zones', () => {
    process.env.TZ = 'Pacific/Auckland';
    const auckland = rangeInstants({ from: '2026-10-01' }).from;
    process.env.TZ = 'America/Winnipeg';
    expect(rangeInstants({ from: '2026-10-01' }).from).not.toBe(auckland);
  });
});

describe('auditPageLinks', () => {
  it('first page: next records nothing, no previous', () => {
    const links = auditPageLinks({}, 50);
    expect(links.previous).toBeNull();
    expect(links.next).toEqual({ after: '50' });
  });

  it('walks forward recording cursors and back popping them', () => {
    const second = auditPageLinks({ after: '50' }, 20);
    expect(second.previous).toEqual({});
    expect(second.next).toEqual({ after: '20', before: '50' });
    const third = auditPageLinks({ after: '20', before: '50' }, 5);
    expect(third.previous).toEqual({ after: '50' });
    expect(third.next).toEqual({ after: '5', before: '50,20' });
  });

  it('the last page has no next, whatever the trail', () => {
    expect(auditPageLinks({ after: '20', before: '50' }, undefined).next).toBeNull();
  });
});

describe('auditFilters', () => {
  it('drops paging and keeps filters', () => {
    expect(auditFilters({ actor: ID, from: '2026-10-01', after: '5', before: '9,7' })).toEqual({
      actor: ID,
      from: '2026-10-01',
    });
  });
});
