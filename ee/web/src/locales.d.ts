// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type crm from './locales/en/crm.json';

declare module '@app/extensions/types.ts' {
  interface ExtensionLocaleResources {
    crm: typeof crm;
  }
}
