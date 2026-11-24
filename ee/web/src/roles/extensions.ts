// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { iconUsers } from '@qm/ui';
import type { ExtensionAdminPage, ExtensionRedirect } from '@app/extensions/types.ts';

/** The custom roles page: owners define roles and hand them to staff. Keep this module light. */
export const rolesAdminPages: ExtensionAdminPage[] = [
  {
    path: 'roles',
    load: async () => {
      const { loadNamespaces } = await import('@app/lib/i18n.ts');
      await loadNamespaces('admin-roles');
      return { default: (await import('./RolesPage.tsx')).RolesPage };
    },
    nav: { group: 'team', icon: iconUsers, labelKey: 'admin-nav:ee.roles', adminOnly: true },
    roles: ['owner', 'admin'],
  },
];

/** `/admin/roles` before the page moved into ee/. */
export const rolesRedirects: ExtensionRedirect[] = [{ from: 'roles', to: 'roles' }];

/** The sidebar label, merged into the app's `admin-nav` strings when they load. */
export const rolesNavStrings = { ee: { roles: 'Roles' } };
