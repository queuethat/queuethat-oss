// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type adminDomains from './locales/en/admin-domains.json';
import type crm from './locales/en/crm.json';

declare module '@app/extensions/types.ts' {
  interface ExtensionLocaleResources {
    crm: typeof crm;
    'admin-domains': typeof adminDomains;
  }
}
