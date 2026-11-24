// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { WebExtensions } from '@app/extensions/types.ts';
import { integrationAdminPages, integrationRedirects } from './src/integrations/extensions.ts';
import { crmAdminPages, crmRedirects, crmSlots } from './src/crm/extensions.ts';
import {
  templatesAdminPages,
  templatesRedirects,
  templatesSlots,
} from './src/templates/extensions.ts';

/**
 * What the QueueThat Commercial License adds to the web app. A build opts in with
 * `QT_WEB_EXTENSIONS=ee/web/extensions.ts`; without it the app holds none of this code. Each
 * feature lives in its own folder under src/ and contributes one list here. Keep this module
 * light: the router imports it into every route's chunk, so pages, slots and strings load lazily.
 */
export const extensions: WebExtensions = {
  adminPages: [...crmAdminPages, ...templatesAdminPages, ...integrationAdminPages],
  banners: [],
  slots: { ...crmSlots, ...templatesSlots },
  redirects: [...crmRedirects, ...templatesRedirects, ...integrationRedirects],
  localeOverrides: async (lng, ns) => {
    if (ns === 'admin-nav' && lng === 'de') return { items: { google: 'Google-Eintrag' } };
    if (lng !== 'en') return undefined;
    if (ns === 'gbp') return (await import('./src/locales/en/gbp.json')).default;
    if (ns === 'admin-nav') return { items: { google: 'Google listing' } };
    if (ns === 'crm') return (await import('./src/locales/en/crm.json')).default;
    if (ns === 'admin-templates')
      return (await import('./src/locales/en/admin-templates.json')).default;
    return undefined;
  },
};
