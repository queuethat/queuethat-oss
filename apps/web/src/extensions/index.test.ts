import { iconHome } from '@qm/ui';
import { describe, expect, it } from 'vitest';
import {
  adminPageUrl,
  bannersFor,
  findAdminPage,
  hasSharedSender,
  installedExtensions,
  redirectFor,
  slotLoader,
  tabPagesFor,
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

  it('redirects an old admin address, and anything under it, to its page', () => {
    const moved: WebExtensions = {
      ...set,
      redirects: [
        { from: 'billing', to: 'billing' },
        { from: 'settings/support', to: 'hidden-page' },
      ],
    };
    expect(installedExtensions(moved)).toBe(moved);
    expect(redirectFor('/admin/billing', moved)).toBe('/admin/x/billing');
    expect(redirectFor('/admin/billing/', moved)).toBe('/admin/x/billing');
    expect(redirectFor('/admin/settings/support/x', moved)).toBe('/admin/x/hidden-page');
    expect(redirectFor('/admin/billings', moved)).toBeUndefined();
    expect(redirectFor('/admin/settings', moved)).toBeUndefined();
    expect(redirectFor('/admin/billing')).toBeUndefined();
  });

  it('rejects a redirect to no page, or from an extension address', () => {
    const to = { ...set, redirects: [{ from: 'billing', to: 'nope' }] };
    expect(() => installedExtensions(to)).toThrow(/no page/);
    const from = { ...set, redirects: [{ from: 'x/billing', to: 'billing' }] };
    expect(() => installedExtensions(from)).toThrow(/bad from/);
  });

  it('lists the pages that join a section', () => {
    const tabbed: WebExtensions = {
      adminPages: [{ path: 'billing', load, tab: { section: 'plan', labelKey: 'x:b' } }],
      banners: [{ id: 'setup', areas: ['onboarding'], load }],
    };
    expect(tabPagesFor('plan', tabbed).map((p) => p.path)).toEqual(['billing']);
    expect(tabPagesFor('privacy', tabbed)).toEqual([]);
    expect(bannersFor('onboarding', tabbed).map((b) => b.id)).toEqual(['setup']);
    expect(bannersFor('admin', tabbed)).toEqual([]);
  });
});
