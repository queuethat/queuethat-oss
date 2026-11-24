// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Source-available under ee/LICENSE.
import { iconChart } from '@qm/ui';
import type {
  ExtensionAdminPage,
  ExtensionRedirect,
} from '../../../apps/web/src/extensions/types.ts';

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
      labelKey: 'admin-reports:nav.reports',
      adminOnly: true,
    },
    tab: { section: 'insights', labelKey: 'admin-reports:nav.scheduled' },
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
      labelKey: 'admin-reports:nav.custom',
      hidden: true,
      under: 'x:reports',
    },
    tab: { section: 'insights', labelKey: 'admin-reports:nav.custom' },
  },
  {
    path: 'ask-analytics',
    load: async () => ({ default: (await import('./ask/AskAnalyticsPage.tsx')).AskAnalyticsPage }),
    nav: {
      group: 'insights',
      icon: iconChart,
      labelKey: 'admin-reports:nav.ask',
      hidden: true,
      under: 'x:reports',
    },
    tab: { section: 'insights', labelKey: 'admin-reports:nav.ask' },
  },
];

/** The old `/admin/reports/*` addresses, when they were part of the core app. */
export const reportRedirects: ExtensionRedirect[] = [
  { from: 'reports/schedules', to: 'reports' },
  { from: 'reports/custom', to: 'reports-custom' },
  { from: 'reports/ask', to: 'ask-analytics' },
];

/** English strings of the `admin-reports` namespace; other languages fall back to them. */
export async function reportLocale(lng: string, ns: string) {
  return lng === 'en' && ns === 'admin-reports'
    ? ((await import('./locales/en/admin-reports.json')).default as Record<string, unknown>)
    : undefined;
}
