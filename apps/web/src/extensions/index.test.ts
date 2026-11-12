import { iconHome } from '@qm/ui';
import { describe, expect, it } from 'vitest';
import {
  adminPageUrl,
  bannersFor,
  findAdminPage,
  hasSharedSender,
  installedExtensions,
  slotLoader,
} from './index.ts';
import { extensions } from './installed.ts';
import type { WebExtensions } from './types.ts';

const load = () => Promise.resolve({ default: () => null });
const set: WebExtensions = {
  adminPages: [
    { path: 'billing', load, nav: { group: 'account', icon: iconHome, labelKey: 'x:billing' } },
    { path: 'hidden-page', load },
  ],
  banners: [
    { id: 'notice', areas: ['staff', 'admin'], load },
    { id: 'admin-only', areas: ['admin'], load },
  ],
};

describe('web extensions', () => {
  it('this repository installs none', () => {
    expect(extensions).toEqual({ adminPages: [], banners: [] });
    expect(installedExtensions().adminPages).toEqual([]);
    expect(findAdminPage('billing')).toBeUndefined();
    expect(bannersFor('admin')).toEqual([]);
    expect(slotLoader('integrations.top')).toBeUndefined();
    expect(hasSharedSender()).toBe(false);
  });

  it('finds a slot and the shared sender flag when a deployment sets them', () => {
    const withSlots: WebExtensions = {
      ...set,
      slots: { 'onboarding.live': load },
      sharedSender: true,
    };
    expect(slotLoader('onboarding.live', withSlots)).toBe(load);
    expect(slotLoader('onboarding.alerts', withSlots)).toBeUndefined();
    expect(hasSharedSender(withSlots)).toBe(true);
  });

  it('finds a page by its path segment only', () => {
    expect(findAdminPage('billing', set)?.path).toBe('billing');
    expect(findAdminPage('billing/x', set)).toBeUndefined();
    expect(findAdminPage(undefined, set)).toBeUndefined();
    expect(adminPageUrl({ path: 'billing' })).toBe('/admin/x/billing');
  });

  it('filters banners by area, keeping their order', () => {
    expect(bannersFor('staff', set).map((b) => b.id)).toEqual(['notice']);
    expect(bannersFor('admin', set).map((b) => b.id)).toEqual(['notice', 'admin-only']);
  });

  it('rejects a bad or duplicate path', () => {
    const page = { path: 'Bad/Path', load };
    expect(() => installedExtensions({ adminPages: [page], banners: [] })).toThrow(/bad path/);
    const dup = { path: 'a', load };
    expect(() => installedExtensions({ adminPages: [dup, dup], banners: [] })).toThrow(/duplicate/);
  });
});
