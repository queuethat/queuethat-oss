// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Source-available under ee/LICENSE.
import type adminReports from './reports/locales/en/admin-reports.json';

declare module '../../apps/web/src/extensions/types.ts' {
  interface ExtensionLocaleResources {
    'admin-reports': typeof adminReports;
  }
}
