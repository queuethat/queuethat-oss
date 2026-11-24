// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { ExtensionAdminPage, ExtensionRedirect } from '@app/extensions/types.ts';
import { iconLink } from '@qm/ui';

/** The Google Business Profile join-link page. Keep this module light. */
export const integrationAdminPages: ExtensionAdminPage[] = [
  {
    path: 'google',
    load: async () => {
      const { loadNamespaces } = await import('@app/lib/i18n.ts');
      await loadNamespaces('gbp');
      return { default: (await import('./GbpPage.tsx')).GbpPage };
    },
    nav: {
      group: 'account',
      icon: iconLink,
      labelKey: 'admin-nav:items.google',
      hidden: true,
      under: 'integrations',
    },
    tab: { section: 'connections', labelKey: 'admin-nav:items.google' },
  },
];

/** `/admin/google` was a core page before it moved here. */
export const integrationRedirects: ExtensionRedirect[] = [{ from: 'google', to: 'google' }];
