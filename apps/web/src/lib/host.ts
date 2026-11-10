import { appConfig } from './config.ts';

/**
 * Host-based routing (3-DOM2, #371). A business can serve its join page on its own domain; that
 * host is an alias for the guest pages only. Staff, admin, devices and sign-in stay on the main
 * host (PUBLIC_URL), where auth redirect URLs and sessions are configured. The database decides
 * which hosts are verified (the domain-check function); this file only routes on its answer.
 */

/** Guest surfaces that work on a custom host. Everything else belongs to the main host. */
const GUEST_PREFIXES = ['/q', '/v', '/a', '/b', '/o', '/w', '/u'];

export function isGuestPath(pathname: string): boolean {
  return GUEST_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * True when `host` (a `location.host`) is some business's own domain: configured public URL, and
 * a different, non-IP, non-localhost name. Without PUBLIC_URL this is always false, so a plain
 * install never looks up or redirects anything.
 */
export function isCustomHost(host: string, publicUrl: string): boolean {
  if (!publicUrl) return false;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  if (!name.includes('.') || /^[\d.]+$/.test(name) || name.includes(':')) return false;
  try {
    return name !== new URL(publicUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export type HostDecision =
  | { kind: 'main' }
  /** A custom host asked for a staff or admin page: send the browser to the main host, same path. */
  | { kind: 'redirect'; href: string }
  /** The custom host is verified: `/` shows this location's join page. */
  | { kind: 'location'; slug: string };

interface HostDeps {
  host: string;
  publicUrl: string;
  /** The location slug of a verified host, null otherwise (domain-check GET). */
  lookup(host: string): Promise<string | null>;
}

/** Decides what a request for `pathname` on this host should do. Pure apart from `lookup`. */
export async function decideHost(
  pathname: string,
  search: string,
  deps: HostDeps,
): Promise<HostDecision> {
  if (!isCustomHost(deps.host, deps.publicUrl)) return { kind: 'main' };
  if (!isGuestPath(pathname) && pathname !== '/') {
    return { kind: 'redirect', href: new URL(pathname + search, deps.publicUrl).href };
  }
  if (pathname !== '/') return { kind: 'main' };
  const slug = await deps.lookup(deps.host);
  return slug ? { kind: 'location', slug } : { kind: 'main' };
}

/** domain-check GET. A network failure is "not a custom domain", never an error page. */
async function lookupViaFunction(host: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${appConfig().supabaseUrl}/functions/v1/domain-check?host=${encodeURIComponent(host)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { location_slug?: string };
    return body.location_slug ?? null;
  } catch {
    return null;
  }
}

/** What to do with the current request, for the router's root guard. */
export function hostDecision(pathname: string, search: string): Promise<HostDecision> {
  return decideHost(pathname, search, {
    host: window.location.host,
    publicUrl: appConfig().publicUrl,
    lookup: lookupViaFunction,
  });
}
