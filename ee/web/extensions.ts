// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { WebExtensions } from '@app/extensions/types.ts';
import { domainsAdminPages, domainsRedirects } from './src/domains/extensions.ts';
import { crmAdminPages, crmRedirects, crmSlots } from './src/crm/extensions.ts';

/**
 * What the QueueThat Commercial License adds to the web app. A build opts in with
 * `QT_WEB_EXTENSIONS=ee/web/extensions.ts`; without it the app holds none of this code. Each
 * feature lives in its own folder under src/ and contributes one list here. Keep this module
 * light: the router imports it into every route's chunk, so pages, slots and strings load lazily.
 */
export const extensions: WebExtensions = {
  adminPages: [...crmAdminPages, ...domainsAdminPages],
  banners: [],
  slots: { ...crmSlots },
  redirects: [...crmRedirects, ...domainsRedirects],
  localeOverrides: async (lng, ns) => {
    if (lng !== 'en') return undefined;
    if (ns === 'crm') return (await import('./src/locales/en/crm.json')).default;
    if (ns === 'admin-domains')
      return (await import('./src/locales/en/admin-domains.json')).default;
    if (ns === 'admin-nav') return { items: { domains: 'Custom domains' } };
    return undefined;
  },
};
