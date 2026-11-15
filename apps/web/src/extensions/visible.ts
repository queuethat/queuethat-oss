import { installedExtensions } from './index.ts';
import type { WebExtensions } from './types.ts';

const always = () => true;

/**
 * The paths of the installed admin pages this member is offered. Calls every page's `useVisible`
 * hook on each render, always in the same order: the installed set is fixed for the life of the
 * bundle, so the hooks rule holds.
 */
export function useVisibleExtensionPages(
  who: { orgId: string | undefined; role: string | undefined },
  set: WebExtensions = installedExtensions(),
): ReadonlySet<string> {
  const shown = new Set<string>();
  for (const page of set.adminPages) {
    if ((page.useVisible ?? always)(who)) shown.add(page.path);
  }
  return shown;
}
