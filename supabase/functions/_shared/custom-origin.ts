// Which browser origins may call a guest-facing Edge Function: the app's own, and any verified custom
// domain of a business (3-DOM1). One rule for every such function, so a new origin never needs
// teaching to each of them again. The database decides what is verified; this only asks it.

export interface OriginGateDeps {
  /** The app's own origin (`new URL(PUBLIC_URL).origin`): always allowed. */
  appOrigin: string;
  /** True when `host` is a verified custom domain. Absent: only the app's own origin is allowed. */
  isCustomDomain?(host: string): Promise<boolean>;
  /** api.hit_rate_limit: true while within the limit. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Rate-limit key prefix, so two functions never share a bucket. */
  bucket: string;
  /** Lookups allowed per network in one window. */
  limit: number;
  windowSeconds: number;
  now?(): number;
  error?(line: string, cause: unknown): void;
}

/**
 * Returns `allowed(origin, network)`. An origin is scheme://host with no port, https only; anything
 * else (a path, plain http, a port) is not a join page. A verified host is remembered for a minute
 * per instance. Refusals are not cached (random hosts would crowd out real ones); instead every
 * lookup counts against a per-network limit, so unknown origins cannot drive unbounded database
 * reads. `network` is the caller's hashed address, computed only when a lookup is needed.
 */
export function createOriginGate(deps: OriginGateDeps): (origin: string, network: () => Promise<string>) => Promise<boolean> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, number>();
  return async (origin, network) => {
    if (origin === deps.appOrigin) return true;
    if (!deps.isCustomDomain) return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || url.port !== '' || url.origin !== origin) return false;
    const cachedAt = cache.get(url.hostname);
    if (cachedAt !== undefined && now() - cachedAt < 60_000) return true;
    if (!(await deps.hit(`${deps.bucket}:${await network()}`, deps.limit, deps.windowSeconds))) return false;
    let ok = false;
    try {
      ok = await deps.isCustomDomain(url.hostname);
    } catch (cause) {
      deps.error?.(`${deps.bucket} custom domain check failed`, cause);
      return false;
    }
    if (ok) {
      if (cache.size >= 1000) cache.clear();
      cache.set(url.hostname, now());
    }
    return ok;
  };
}
