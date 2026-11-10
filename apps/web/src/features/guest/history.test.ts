import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetHistory, historyFor, HISTORY_LIMIT, readHistory, recordJoin } from './history.ts';

const entry = (slug: string, over = {}) => ({
  slug,
  queueId: 'q1',
  serviceId: 's1',
  name: 'Robin',
  at: '2026-10-31T10:00:00Z',
  ...over,
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('join history', () => {
  it('returns the newest join for a location', () => {
    recordJoin(entry('shop', { name: 'Old', queueId: 'q1' }));
    recordJoin(entry('shop', { name: 'New', queueId: 'q2' }));
    expect(historyFor('shop')?.name).toBe('New');
    expect(historyFor('elsewhere')).toBeNull();
  });

  it('replaces an earlier join of the same queue instead of duplicating it', () => {
    recordJoin(entry('shop', { name: 'A' }));
    recordJoin(entry('shop', { name: 'B' }));
    expect(readHistory().map((e) => e.name)).toEqual(['B']);
  });

  it('keeps at most 10 joins, dropping the oldest', () => {
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) recordJoin(entry(`shop${i}`));
    const all = readHistory();
    expect(all).toHaveLength(HISTORY_LIMIT);
    expect(all[0]?.slug).toBe(`shop${HISTORY_LIMIT + 2}`);
  });

  it('stores no token or contact data', () => {
    recordJoin(entry('shop'));
    expect(Object.keys(JSON.parse(localStorage.getItem('qm:join-history')!)[0]).sort()).toEqual([
      'at',
      'name',
      'queueId',
      'serviceId',
      'slug',
    ]);
  });

  it('forget clears everything', () => {
    recordJoin(entry('shop'));
    forgetHistory();
    expect(readHistory()).toEqual([]);
  });

  it('ignores damaged data', () => {
    localStorage.setItem('qm:join-history', '{"nope":1}');
    expect(readHistory()).toEqual([]);
    localStorage.setItem('qm:join-history', JSON.stringify([{ slug: 1 }, entry('ok')]));
    expect(readHistory().map((e) => e.slug)).toEqual(['ok']);
  });

  it('AC2: works without storage (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readHistory()).toEqual([]);
    expect(() => recordJoin(entry('shop'))).not.toThrow();
    expect(historyFor('shop')).toBeNull();
    expect(() => forgetHistory()).not.toThrow();
  });
});
