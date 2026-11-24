// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type adminReports from './locales/en/admin-reports.json';

declare module '@app/extensions/types.ts' {
  interface ExtensionLocaleResources {
    'admin-reports': typeof adminReports;
  }
}
