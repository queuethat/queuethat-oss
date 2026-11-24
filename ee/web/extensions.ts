// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { WebExtensions } from '@app/extensions/types.ts';
import { rolesAdminPages, rolesNavStrings, rolesRedirects } from './src/roles/extensions.ts';
import { shiftsAdminPages, shiftsNavStrings, shiftsRedirects } from './src/shifts/extensions.ts';
import { paymentsSlots } from './src/payments/extensions.ts';
import { crmAdminPages, crmRedirects, crmSlots } from './src/crm/extensions.ts';

/**
 * What the QueueThat Commercial License adds to the web app. A build opts in with
 * `QT_WEB_EXTENSIONS=ee/web/extensions.ts`; without it the app holds none of this code. Each
 * feature lives in its own folder under src/ and contributes one list here. Keep this module
 * light: the router imports it into every route's chunk, so pages, slots and strings load lazily.
 */
export const extensions: WebExtensions = {
  adminPages: [...crmAdminPages, ...rolesAdminPages, ...shiftsAdminPages],
  banners: [],
  slots: { ...crmSlots, ...paymentsSlots },
  redirects: [...crmRedirects, ...rolesRedirects, ...shiftsRedirects],
  localeOverrides: async (lng, ns) => {
    // Sidebar labels are English only, like the staff screens.
    if (ns === 'admin-nav') return { ee: { ...rolesNavStrings, ...shiftsNavStrings } };
    if (lng !== 'en') return undefined;
    if (ns === 'crm') return (await import('./src/locales/en/crm.json')).default;
    if (ns === 'admin-roles') return (await import('./src/locales/en/admin-roles.json')).default;
    if (ns === 'payments-desk')
      return (await import('./src/locales/en/payments-desk.json')).default;
    if (ns === 'shifts') return (await import('./src/locales/en/shifts.json')).default;
    if (ns === 'planning') return (await import('./src/locales/en/planning.json')).default;
    return undefined;
  },
};
