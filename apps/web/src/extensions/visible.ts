import { installedExtensions } from './index.ts';
import type { WebExtensions } from './types.ts';

/** The paths of the installed admin pages a member with this role is offered (`roles`). */
export function visibleExtensionPages(
  role: string | undefined,
  set: WebExtensions = installedExtensions(),
): ReadonlySet<string> {
  return new Set(
    set.adminPages
      .filter((p) => !p.roles || (role !== undefined && p.roles.includes(role)))
      .map((p) => p.path),
  );
}
