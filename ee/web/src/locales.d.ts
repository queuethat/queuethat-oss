// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type adminReports from './locales/en/admin-reports.json';
import type adminRoles from './locales/en/admin-roles.json';
import type adminTemplates from './locales/en/admin-templates.json';
import type crm from './locales/en/crm.json';
import type gbp from './locales/en/gbp.json';
import type paymentsDesk from './locales/en/payments-desk.json';
import type planning from './locales/en/planning.json';
import type shifts from './locales/en/shifts.json';

declare module '@app/extensions/types.ts' {
  interface ExtensionLocaleResources {
    crm: typeof crm;
    'admin-reports': typeof adminReports;
    // Merged over the app's own `admin-templates` (its queue look strings).
    'admin-templates': typeof adminTemplates;
    'admin-roles': typeof adminRoles;
    'payments-desk': typeof paymentsDesk;
    planning: typeof planning;
    shifts: typeof shifts;
    gbp: typeof gbp;
  }
}
