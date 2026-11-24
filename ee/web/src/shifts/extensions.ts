// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { iconClock } from '@qm/ui';
import type { ExtensionAdminPage, ExtensionRedirect } from '@app/extensions/types.ts';

const withStrings = async (namespace: 'shifts' | 'planning') => {
  const { loadNamespaces } = await import('@app/lib/i18n.ts');
  await loadNamespaces(namespace);
};

/** Shifts, the member's own shifts, and the planning grid. Keep this module light. */
export const shiftsAdminPages: ExtensionAdminPage[] = [
  {
    path: 'shifts',
    load: async () => {
      await withStrings('shifts');
      return { default: (await import('./ShiftsPage.tsx')).ShiftsPage };
    },
    nav: { group: 'team', icon: iconClock, labelKey: 'admin-nav:ee.shifts' },
  },
  {
    path: 'my-shifts',
    load: async () => {
      await withStrings('shifts');
      return { default: (await import('./ShiftsPage.tsx')).MyShiftsPage };
    },
    // Every member sees their own upcoming shifts, read only.
    nav: { group: 'team', icon: iconClock, labelKey: 'admin-nav:ee.myShifts' },
  },
  {
    path: 'planning',
    load: async () => {
      await withStrings('planning');
      return { default: (await import('../planning/PlanningPage.tsx')).PlanningPage };
    },
    nav: { group: 'team', icon: iconClock, labelKey: 'admin-nav:ee.planning' },
  },
];

/** `/admin/shifts` before the page moved into ee/. (`/staff/shifts` and `/staff/planning` are gone.) */
export const shiftsRedirects: ExtensionRedirect[] = [{ from: 'shifts', to: 'shifts' }];

/** Sidebar labels, merged into the app's `admin-nav` strings when they load. */
export const shiftsNavStrings = { shifts: 'Shifts', myShifts: 'My shifts', planning: 'Planning' };
