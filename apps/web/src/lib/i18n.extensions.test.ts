import { beforeEach, describe, expect, it, vi } from 'vitest';

// A deployment that rewords one string in a lazy namespace and one in a bundled one.
vi.mock('../extensions/installed.ts', () => ({
  extensions: {
    adminPages: [],
    banners: [],
    localeOverrides: async (lng: string, ns: string) =>
      lng !== 'en'
        ? undefined
        : ns === 'admin-nav'
          ? { items: { usage: 'Plan and usage' } }
          : ns === 'common'
            ? { toast: { dismiss: 'Close it' } }
            : undefined,
  },
}));

// The test setup already loaded i18n without the mock: load it again for each case.
beforeEach(() => vi.resetModules());

describe('i18n with a deployment’s wording', () => {
  it('merges it over a namespace when it loads, keeping the other strings', async () => {
    const { default: i18n, loadNamespaces } = await import('./i18n.ts');
    await loadNamespaces('admin-nav');
    expect(i18n.t('admin-nav:items.usage')).toBe('Plan and usage');
    expect(i18n.t('admin-nav:items.team')).not.toBe('items.team');
  });

  it('applies it to a bundled namespace once the app has started', async () => {
    const { default: i18n } = await import('./i18n.ts');
    await vi.waitFor(() => expect(i18n.t('common:toast.dismiss')).toBe('Close it'));
    expect(i18n.t('common:toast.undo')).not.toBe('toast.undo');
  });
});
