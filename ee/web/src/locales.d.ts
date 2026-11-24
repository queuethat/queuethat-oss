// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type gbp from './locales/en/gbp.json';
import type crm from './locales/en/crm.json';
import type adminReports from './locales/en/admin-reports.json';
import type adminTemplates from './locales/en/admin-templates.json';

declare module '@app/extensions/types.ts' {
  interface ExtensionLocaleResources {
    crm: typeof crm;
    'admin-reports': typeof adminReports;
    // Merged over the app's own `admin-templates` (its queue look strings).
    'admin-templates': typeof adminTemplates;
    gbp: typeof gbp;
  }
}
