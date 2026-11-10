import { describe, expect, it } from 'vitest';
import { afterIdForMove } from './position.ts';

const ids = ['a', 'b', 'c', 'd'];

describe('afterIdForMove', () => {
  it('moves to the front with no neighbour', () => {
    expect(afterIdForMove(ids, 'c', 0)).toEqual({ afterId: null });
  });
  it('moves down to just after the item now above it', () => {
    expect(afterIdForMove(ids, 'a', 2)).toEqual({ afterId: 'c' });
    expect(afterIdForMove(ids, 'a', 3)).toEqual({ afterId: 'd' });
  });
  it('moves up to just after the item now above it', () => {
    expect(afterIdForMove(ids, 'd', 1)).toEqual({ afterId: 'a' });
  });
  it('is null when nothing changes or the target is out of range', () => {
    expect(afterIdForMove(ids, 'b', 1)).toBeNull();
    expect(afterIdForMove(ids, 'b', 4)).toBeNull();
    expect(afterIdForMove(ids, 'x', 0)).toBeNull();
  });
});
