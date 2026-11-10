import { describe, expect, it } from 'vitest';
import { currentTabId, reportTabs, sectionAt, type TabAccess } from './sectionTabs.ts';

const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);
const access = (extra: Partial<TabAccess> = {}): TabAccess => ({
  admin: true,
  multiLocation: false,
  ...extra,
});
const tabsAt = (pathname: string, extra: Partial<TabAccess> = {}) =>
  sectionAt(pathname)?.tabs(access(extra)) ?? [];

describe('insights section', () => {
  it('gives an admin of several locations seven tabs, Reports opening the scheduled page', () => {
    const tabs = tabsAt('/admin/analytics', { multiLocation: true });
    expect(ids(tabs)).toEqual([
      'analytics',
      'heatmap',
      'performance',
      'etaAccuracy',
      'feedback',
      'reports',
      'comparison',
    ]);
    expect(tabs.find((t) => t.id === 'reports')!.to).toBe('/admin/reports/schedules');
  });

  it('hides location comparison from single-location businesses and from staff', () => {
    expect(ids(tabsAt('/admin/analytics'))).not.toContain('comparison');
    expect(ids(tabsAt('/admin/analytics', { admin: false, multiLocation: true }))).not.toContain(
      'comparison',
    );
  });

  it('sends staff to the custom report page, which they may open', () => {
    const tabs = tabsAt('/admin/analytics', { admin: false });
    expect(tabs.find((t) => t.id === 'reports')!.to).toBe('/admin/reports/custom');
    expect(ids(reportTabs(false))).toEqual(['custom', 'ask']);
    expect(ids(reportTabs(true))).toEqual(['schedules', 'custom', 'ask']);
  });

  it('marks the tab holding the path, report sub-pages included', () => {
    const tabs = tabsAt('/admin/analytics', { multiLocation: true });
    expect(currentTabId(tabs, '/admin/heatmap')).toBe('heatmap');
    expect(currentTabId(tabs, '/admin/reports/ask')).toBe('reports');
    expect(currentTabId(tabs, '/admin/queues')).toBeUndefined();
    expect(currentTabId(reportTabs(true), '/admin/reports/custom')).toBe('custom');
  });
});

describe('account sections', () => {
  it('groups connections, developers, privacy and plan pages', () => {
    expect(ids(tabsAt('/admin/whatsapp'))).toEqual([
      'integrations',
      'whatsapp',
      'google',
      'calendar',
    ]);
    expect(ids(tabsAt('/admin/account/calendar'))).toContain('calendar');
    expect(ids(tabsAt('/admin/domains'))).toEqual(['apiKeys', 'webhooks', 'chatAlerts', 'domains']);
    expect(ids(tabsAt('/admin/export'))).toEqual(['privacy', 'requests', 'export']);
    expect(ids(tabsAt('/admin/usage'))).toEqual(['usage']);
  });

  it('leaves developers to admins', () => {
    expect(tabsAt('/admin/developers/webhooks', { admin: false })).toEqual([]);
    expect(ids(tabsAt('/admin/privacy', { admin: false }))).toEqual(['privacy']);
  });

  it('marks Data requests, not Privacy, on the requests page', () => {
    const tabs = tabsAt('/admin/privacy');
    expect(currentTabId(tabs, '/admin/privacy')).toBe('privacy');
    expect(currentTabId(tabs, '/admin/privacy/requests')).toBe('requests');
  });
});

describe('sectionAt', () => {
  it('finds the section of a page, and none for lookalikes or other pages', () => {
    expect(sectionAt('/admin/reports/schedules')?.id).toBe('insights');
    expect(sectionAt('/admin/developers/api-keys')?.id).toBe('developers');
    expect(sectionAt('/admin/analytics-export')).toBeUndefined();
    expect(sectionAt('/admin')).toBeUndefined();
    expect(sectionAt('/admin/queues')).toBeUndefined();
    expect(sectionAt('/admin/settings/support')).toBeUndefined();
  });
});
