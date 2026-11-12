import { extensions } from './installed.ts';
import type { ExtensionAdminPage, ExtensionBanner, WebExtensions } from './types.ts';

export type {
  ExtensionAdminPage,
  ExtensionBanner,
  ExtensionNavGroup,
  WebExtensions,
} from './types.ts';

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** The installed extensions, checked once: a bad path or a duplicate fails the first render loudly. */
export function installedExtensions(set: WebExtensions = extensions): WebExtensions {
  const seen = new Set<string>();
  for (const page of set.adminPages) {
    if (!SEGMENT.test(page.path)) throw new Error(`extension admin page: bad path "${page.path}"`);
    if (seen.has(page.path)) throw new Error(`extension admin page: duplicate path "${page.path}"`);
    seen.add(page.path);
  }
  return set;
}

/** The URL of an extension admin page. */
export function adminPageUrl(page: Pick<ExtensionAdminPage, 'path'>): string {
  return `/admin/x/${page.path}`;
}

/** The extension page for the `/admin/x/$` splat, or undefined. */
export function findAdminPage(
  splat: string | undefined,
  set: WebExtensions = installedExtensions(),
): ExtensionAdminPage | undefined {
  return set.adminPages.find((p) => p.path === splat);
}

/** Banners for one area, in the order the extension lists them. */
export function bannersFor(
  area: 'staff' | 'admin',
  set: WebExtensions = installedExtensions(),
): ExtensionBanner[] {
  return set.banners.filter((b) => b.areas.includes(area));
}
