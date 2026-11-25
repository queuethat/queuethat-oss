// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { WebExtensions } from '@app/extensions/types.ts';
import { domainsAdminPages, domainsRedirects } from './src/domains/extensions.ts';
import { reportPages, reportRedirects, reportsNavStrings } from './src/reports/extension.ts';
import { integrationAdminPages, integrationRedirects } from './src/integrations/extensions.ts';
import { crmAdminPages, crmRedirects, crmSlots } from './src/crm/extensions.ts';
import { paymentsSlots } from './src/payments/extensions.ts';
import { rolesAdminPages, rolesNavStrings, rolesRedirects } from './src/roles/extensions.ts';
import { shiftsAdminPages, shiftsNavStrings, shiftsRedirects } from './src/shifts/extensions.ts';
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
  adminPages: [
    ...crmAdminPages,
    ...templatesAdminPages,
    ...integrationAdminPages,
    ...reportPages,
    ...domainsAdminPages,
    ...rolesAdminPages,
    ...shiftsAdminPages,
  ],
  banners: [],
  slots: { ...crmSlots, ...templatesSlots, ...paymentsSlots },
  redirects: [
    ...crmRedirects,
    ...templatesRedirects,
    ...integrationRedirects,
    ...reportRedirects,
    ...domainsRedirects,
    ...rolesRedirects,
    ...shiftsRedirects,
  ],
  localeOverrides: async (lng, ns) => {
    if (ns === 'admin-nav' && lng === 'de')
      return { items: { google: 'Google-Eintrag', domains: 'Eigene Domains' } };
    if (lng !== 'en') return undefined;
    if (ns === 'gbp') return (await import('./src/locales/en/gbp.json')).default;
    // Sidebar labels of the pages in this folder.
    if (ns === 'admin-nav')
      return {
        items: { google: 'Google listing', domains: 'Custom domains' },
        ee: { ...rolesNavStrings, ...shiftsNavStrings, ...reportsNavStrings },
      };
    if (ns === 'crm') return (await import('./src/locales/en/crm.json')).default;
    if (ns === 'admin-reports')
      return (await import('./src/locales/en/admin-reports.json')).default;
    if (ns === 'admin-templates')
      return (await import('./src/locales/en/admin-templates.json')).default;
    if (ns === 'admin-domains')
      return (await import('./src/locales/en/admin-domains.json')).default;
    if (ns === 'admin-roles') return (await import('./src/locales/en/admin-roles.json')).default;
    if (ns === 'payments-desk')
      return (await import('./src/locales/en/payments-desk.json')).default;
    if (ns === 'shifts') return (await import('./src/locales/en/shifts.json')).default;
    if (ns === 'planning') return (await import('./src/locales/en/planning.json')).default;
    return undefined;
  },
};
