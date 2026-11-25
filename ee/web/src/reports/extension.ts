// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Source-available under ee/LICENSE.
import { iconChart } from '@qm/ui';
import type { ExtensionAdminPage, ExtensionRedirect } from '@app/extensions/types.ts';

/**
 * Scheduled, custom and "ask your data" reports. Keep this module free of data imports: it sits in
 * every route's chunk, so the pages load on demand.
 */
export const reportPages: ExtensionAdminPage[] = [
  {
    path: 'reports',
    load: async () => ({
      default: (await import('./ReportSchedulesPage.tsx')).ReportSchedulesPage,
    }),
    nav: {
      group: 'insights',
      icon: iconChart,
      labelKey: 'admin-nav:ee.reports',
      adminOnly: true,
    },
    tab: { section: 'insights', labelKey: 'admin-nav:ee.reportsScheduled' },
    // The page also guards itself; this only hides the link from staff.
    roles: ['owner', 'admin'],
  },
  {
    path: 'reports-custom',
    load: async () => ({
      default: (await import('./custom/CustomReportPage.tsx')).CustomReportPage,
    }),
    nav: {
      group: 'insights',
      icon: iconChart,
      labelKey: 'admin-nav:ee.reportsCustom',
      hidden: true,
      under: 'x:reports',
    },
    tab: { section: 'insights', labelKey: 'admin-nav:ee.reportsCustom' },
  },
  {
    path: 'ask-analytics',
    load: async () => ({ default: (await import('./ask/AskAnalyticsPage.tsx')).AskAnalyticsPage }),
    nav: {
      group: 'insights',
      icon: iconChart,
      labelKey: 'admin-nav:ee.reportsAsk',
      hidden: true,
      under: 'x:reports',
    },
    tab: { section: 'insights', labelKey: 'admin-nav:ee.reportsAsk' },
  },
];

/**
 * Sidebar and tab labels, merged into the app's `admin-nav` strings when they load. The nav renders
 * before any page's own namespace loads, so labels in `admin-reports` showed as raw keys.
 */
export const reportsNavStrings = {
  reports: 'Reports',
  reportsScheduled: 'Scheduled reports',
  reportsCustom: 'Custom reports',
  reportsAsk: 'Ask analytics',
};

/** The old `/admin/reports/*` addresses, when they were part of the core app. */
export const reportRedirects: ExtensionRedirect[] = [
  { from: 'reports/schedules', to: 'reports' },
  { from: 'reports/custom', to: 'reports-custom' },
  { from: 'reports/ask', to: 'ask-analytics' },
];
