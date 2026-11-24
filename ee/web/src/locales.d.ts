// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type adminRoles from './locales/en/admin-roles.json';
import type paymentsDesk from './locales/en/payments-desk.json';
import type planning from './locales/en/planning.json';
import type shifts from './locales/en/shifts.json';
import type crm from './locales/en/crm.json';

declare module '@app/extensions/types.ts' {
  interface ExtensionLocaleResources {
    crm: typeof crm;
    'payments-desk': typeof paymentsDesk;
    planning: typeof planning;
    shifts: typeof shifts;
    'admin-roles': typeof adminRoles;
  }
}
