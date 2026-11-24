// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { iconBell } from '@qm/ui';
import type {
  ExtensionAdminPage,
  ExtensionRedirect,
  ExtensionSlots,
} from '@app/extensions/types.ts';

/** Loads the namespace (its ee strings merge in through `localeOverrides`), then the module. */
async function withTemplateStrings<T>(load: () => Promise<T>): Promise<T> {
  const { loadNamespaces } = await import('@app/lib/i18n.ts');
  await loadNamespaces('admin-templates');
  return load();
}

/** The message templates editor: wording per trigger, channel and guest language. Keep this module light. */
export const templatesAdminPages: ExtensionAdminPage[] = [
  {
    path: 'templates',
    load: () =>
      withTemplateStrings(async () => ({
        default: (await import('./TemplatesPage.tsx')).TemplatesPage,
      })),
    nav: { group: 'setup', icon: iconBell, labelKey: 'admin-nav:items.templates' },
  },
];

export const templatesRedirects: ExtensionRedirect[] = [{ from: 'templates', to: 'templates' }];

export const templatesSlots: ExtensionSlots = {
  'queue.templates': () => withTemplateStrings(() => import('./QueueTemplates.tsx')),
};
