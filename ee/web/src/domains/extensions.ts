// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { iconLink } from '@qm/ui';
import type { ExtensionAdminPage, ExtensionRedirect } from '@app/extensions/types.ts';

/** The tab label and nav entry text; the app looks it up in its own `admin-nav` namespace. */
export const DOMAINS_LABEL = 'admin-nav:items.domains';

/**
 * Custom domains: the owner's setup page (claim a hostname, copy the DNS records, check them,
 * remove). The table, the `api.*` functions, host resolution and `domain-check` stay in core.
 * Keep this module light: the router imports it into every route's chunk.
 */
export const domainsAdminPages: ExtensionAdminPage[] = [
  {
    path: 'domains',
    load: async () => {
      const { loadNamespaces } = await import('@app/lib/i18n.ts');
      await loadNamespaces('admin-domains');
      return { default: (await import('./DomainsPage.tsx')).DomainsPage };
    },
    nav: {
      group: 'account',
      icon: iconLink,
      labelKey: DOMAINS_LABEL,
      adminOnly: true,
      hidden: true,
      under: 'apiKeys',
    },
    tab: { section: 'developers', labelKey: DOMAINS_LABEL },
    roles: ['owner', 'admin'],
  },
];

/** The old address of the page keeps working. */
export const domainsRedirects: ExtensionRedirect[] = [{ from: 'domains', to: 'domains' }];
