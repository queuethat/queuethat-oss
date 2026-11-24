// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { WebExtensions } from '@app/extensions/types.ts';
import { reportPages, reportRedirects } from './src/reports/extension.ts';
import { crmAdminPages, crmRedirects, crmSlots } from './src/crm/extensions.ts';

/**
 * What the QueueThat Commercial License adds to the web app. A build opts in with
 * `QT_WEB_EXTENSIONS=ee/web/extensions.ts`; without it the app holds none of this code. Each
 * feature lives in its own folder under src/ and contributes one list here. Keep this module
 * light: the router imports it into every route's chunk, so pages, slots and strings load lazily.
 */
export const extensions: WebExtensions = {
  adminPages: [...crmAdminPages, ...reportPages],
  banners: [],
  slots: { ...crmSlots },
  redirects: [...crmRedirects, ...reportRedirects],
  localeOverrides: async (lng, ns) => {
    if (lng !== 'en') return undefined;
    if (ns === 'crm') return (await import('./src/locales/en/crm.json')).default;
    if (ns === 'admin-reports')
      return (await import('./src/locales/en/admin-reports.json')).default;
    return undefined;
  },
};
