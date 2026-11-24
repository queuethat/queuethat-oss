import { describe, expect, it } from 'vitest';
import { mergeExtensions } from './merge.ts';
import type { WebExtensions } from './types.ts';

const page = (path: string) => ({ path, load: async () => ({ default: () => null }) });
const slot = (n: string) => async () => ({ default: () => n as unknown as null });

describe('mergeExtensions', () => {
  it('joins pages, banners and redirects in order', () => {
    const a: WebExtensions = {
      adminPages: [page('a')],
      banners: [],
      redirects: [{ from: 'x', to: 'a' }],
    };
    const b: WebExtensions = {
      adminPages: [page('b')],
      banners: [{ id: 'n', areas: ['admin'], load: async () => ({ default: () => null }) }],
    };
    const m = mergeExtensions([a, b]);
    expect(m.adminPages.map((p) => p.path)).toEqual(['a', 'b']);
    expect(m.banners.map((x) => x.id)).toEqual(['n']);
    expect(m.redirects).toEqual([{ from: 'x', to: 'a' }]);
  });

  it('lets the later module win a slot, and keeps flags and help articles', () => {
    const first = slot('first');
    const second = slot('second');
    const m = mergeExtensions([
      { adminPages: [], banners: [], slots: { 'limits.reached': first }, helpArticles: ['one'] },
      {
        adminPages: [],
        banners: [],
        slots: { 'limits.reached': second },
        helpArticles: ['two'],
        sharedSender: true,
      },
    ]);
    expect(m.slots?.['limits.reached']).toBe(second);
    expect(m.helpArticles).toEqual(['one', 'two']);
    expect(m.sharedSender).toBe(true);
  });

  it('deep-merges locale overrides, later first-class', async () => {
    const m = mergeExtensions([
      {
        adminPages: [],
        banners: [],
        localeOverrides: async (_l, ns) =>
          ns === 'admin-nav' ? { items: { a: '1', b: '2' } } : undefined,
      },
      {
        adminPages: [],
        banners: [],
        localeOverrides: async (_l, ns) => (ns === 'admin-nav' ? { items: { b: '3' } } : undefined),
      },
    ]);
    expect(await m.localeOverrides?.('en', 'admin-nav')).toEqual({ items: { a: '1', b: '3' } });
    expect(await m.localeOverrides?.('en', 'other')).toBeUndefined();
  });

  it('is the identity shape for one module without overrides', () => {
    const m = mergeExtensions([{ adminPages: [], banners: [] }]);
    expect(m.localeOverrides).toBeUndefined();
    expect(m.helpArticles).toBeUndefined();
  });
});
