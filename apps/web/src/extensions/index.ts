import { extensions } from './installed.ts';
import type {
  ExtensionAdminPage,
  ExtensionBanner,
  ExtensionBannerArea,
  ExtensionTabSection,
  ExtensionSlotName,
  ExtensionSlots,
  WebExtensions,
} from './types.ts';

export type {
  ExtensionAdminPage,
  ExtensionBanner,
  ExtensionBannerArea,
  ExtensionLocaleResources,
  ExtensionRedirect,
  ExtensionTabSection,
  IncidentLogEntry,
  ExtensionNavGroup,
  ExtensionSlotName,
  ExtensionSlotProps,
  ExtensionSlots,
  WebExtensions,
} from './types.ts';

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
// One or more segments under /admin, never an extension page's own address.
const REDIRECT_FROM = /^(?!x(\/|$))[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/** The installed extensions, checked once: a bad path or a duplicate fails the first render loudly. */
export function installedExtensions(set: WebExtensions = extensions): WebExtensions {
  const seen = new Set<string>();
  for (const page of set.adminPages) {
    if (!SEGMENT.test(page.path)) throw new Error(`extension admin page: bad path "${page.path}"`);
    if (seen.has(page.path)) throw new Error(`extension admin page: duplicate path "${page.path}"`);
    seen.add(page.path);
  }
  for (const r of set.redirects ?? []) {
    if (!REDIRECT_FROM.test(r.from)) throw new Error(`extension redirect: bad from "${r.from}"`);
    if (!seen.has(r.to)) throw new Error(`extension redirect: no page "${r.to}"`);
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
  area: ExtensionBannerArea,
  set: WebExtensions = installedExtensions(),
): ExtensionBanner[] {
  return set.banners.filter((b) => b.areas.includes(area));
}

/** The loader a deployment installed for a slot, or undefined. */
export function slotLoader<K extends ExtensionSlotName>(
  name: K,
  set: WebExtensions = installedExtensions(),
): ExtensionSlots[K] | undefined {
  return set.slots?.[name];
}

/** True when the deployment offers its shared sender on the Integrations page. */
export function hasSharedSender(set: WebExtensions = installedExtensions()): boolean {
  return set.sharedSender === true;
}

/**
 * Where an old admin address now lives, or undefined: `/admin/<from>` or a path under it maps to the
 * extension page `/admin/x/<to>`.
 */
export function redirectFor(
  pathname: string,
  set: WebExtensions = installedExtensions(),
): string | undefined {
  const rest = pathname.replace(/^\/admin\//, '').replace(/\/+$/, '');
  const hit = set.redirects?.find((r) => rest === r.from || rest.startsWith(`${r.from}/`));
  return hit ? adminPageUrl({ path: hit.to }) : undefined;
}

/** The pages that join a section's tab bar, in installed order. */
export function tabPagesFor(
  section: ExtensionTabSection,
  set: WebExtensions = installedExtensions(),
): ExtensionAdminPage[] {
  return set.adminPages.filter((p) => p.tab?.section === section);
}
