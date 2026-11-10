import { describe, expect, it } from 'vitest';
import type { ConsoleVisit } from '../api.ts';
import { applyFilters, isFiltering, NO_FILTERS, toggle } from './filters.ts';

const visit = (id: string, over: Partial<ConsoleVisit>) =>
  ({ id, service: null, status: 'waiting', tags: [], ...over }) as ConsoleVisit;

const visits = [
  visit('a', { service: 'Colour', tags: ['VIP'], assignedStaffId: 'ben' }),
  visit('b', { service: 'Trim', status: 'called' }),
  visit('c', { service: 'Colour', status: 'serving', tags: ['needs help'] }),
  visit('d', { assignedCounterId: 'room2' }),
];
const ids = (v: ConsoleVisit[]) => v.map((x) => x.id);

describe('applyFilters', () => {
  it('shows everything without filters', () => {
    expect(ids(applyFilters(visits, NO_FILTERS))).toEqual(['a', 'b', 'c', 'd']);
    expect(isFiltering(NO_FILTERS)).toBe(false);
  });
  it('matches any chip of a group and all groups together', () => {
    expect(ids(applyFilters(visits, { ...NO_FILTERS, services: ['Colour'] }))).toEqual(['a', 'c']);
    expect(ids(applyFilters(visits, { ...NO_FILTERS, services: ['Colour', 'Trim'] }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      ids(
        applyFilters(visits, {
          services: ['Colour'],
          statuses: ['serving'],
          tags: [],
          mine: false,
        }),
      ),
    ).toEqual(['c']);
    expect(ids(applyFilters(visits, { ...NO_FILTERS, tags: ['VIP', 'needs help'] }))).toEqual([
      'a',
      'c',
    ]);
  });
  it('a visit without a service never matches a service filter', () => {
    expect(ids(applyFilters(visits, { ...NO_FILTERS, services: ['Trim'] }))).toEqual(['b']);
  });
});

describe('mine', () => {
  const mine = { ...NO_FILTERS, mine: true };
  it('keeps guests assigned to me or my counter', () => {
    expect(ids(applyFilters(visits, mine, { userId: 'ben', counterId: null }))).toEqual(['a']);
    expect(ids(applyFilters(visits, mine, { userId: 'ana', counterId: 'room2' }))).toEqual(['d']);
    expect(ids(applyFilters(visits, mine, { userId: 'ben', counterId: 'room2' }))).toEqual([
      'a',
      'd',
    ]);
  });
  it('shows nobody when I am not identified yet', () => {
    expect(ids(applyFilters(visits, mine))).toEqual([]);
    expect(isFiltering(mine)).toBe(true);
  });
});

describe('toggle', () => {
  it('adds then removes', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});
