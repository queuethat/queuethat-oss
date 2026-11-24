// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { WebExtensions } from '@app/extensions/types.ts';
import { reportPages, reportRedirects } from './src/reports/extension.ts';

/**
 * What the QueueThat Commercial License adds to the web app. A build opts in with
 * `QT_WEB_EXTENSIONS=<absolute path to this file>`; without it the app holds none of this code.
 * Each feature lives in its own folder under src/ and contributes lists that are spread in here.
 * Keep this module light: the router imports it into every route's chunk, so pages, slots and
 * strings load lazily (dynamic import).
 */
export const extensions: WebExtensions = {
  adminPages: [...reportPages],
  banners: [],
  slots: {},
  redirects: [...reportRedirects],
  localeOverrides: async (lng, ns) =>
    lng === 'en' && ns === 'admin-reports'
      ? (await import('./src/locales/en/admin-reports.json')).default
      : undefined,
};
