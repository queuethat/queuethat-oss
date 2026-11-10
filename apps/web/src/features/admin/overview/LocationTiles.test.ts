import { describe, expect, it } from 'vitest';
import type { LocationTile } from './api.ts';
import { byLongestWait } from './LocationTiles.tsx';

const tile = (name: string, longestWaitMin: number | null): LocationTile => ({
  locationId: name,
  name,
  queuesOpen: 1,
  waiting: 0,
  longestWaitMin,
  etaLow: null,
  etaHigh: null,
  asOf: '2026-11-08T17:00:00Z',
});

describe('byLongestWait', () => {
  it('puts the longest wait first and locations with no wait last', () => {
    const sorted = byLongestWait([tile('Quiet', null), tile('Busy', 40), tile('Steady', 12)]);
    expect(sorted.map((t) => t.name)).toEqual(['Busy', 'Steady', 'Quiet']);
  });

  it('breaks ties by name and leaves the input untouched', () => {
    const input = [tile('Zed', 5), tile('Ann', 5)];
    expect(byLongestWait(input).map((t) => t.name)).toEqual(['Ann', 'Zed']);
    expect(input.map((t) => t.name)).toEqual(['Zed', 'Ann']);
  });

  it('ranks a zero-minute wait above a location with nobody waiting', () => {
    expect(byLongestWait([tile('None', null), tile('Zero', 0)]).map((t) => t.name)).toEqual([
      'Zero',
      'None',
    ]);
  });
});
