// 3-DOM1 (#370): domain-check. Answers "is this hostname ours, and which location does it serve?"
// for the TLS layer (Caddy on-demand TLS `ask`, a hosting provider's custom hostnames) and the SPA, and proves
// ownership of a hostname with a DNS TXT record. An Edge Function because only it resolves DNS
// (technical-design.md 3.5, rule 3: it adds a capability). The gateway's JWT check is off; each
// route carries its own gate.
//
// GET  ?host=<hostname>  (or ?domain=, the name Caddy's `ask` sends)   public
//   200 { location_slug }  only for a verified hostname of an active org
//   404 { error: "not_found" }  anything else, with no hint why
// POST { domain_id }  Authorization: Bearer <user JWT>   an owner or admin of the domain's org
//   200 { status }          checked _queue-verify.<host> TXT for the domain's token
//   401 not signed in · 404 unknown or foreign domain · 502 DNS resolver unreachable (no strike)
// POST {}  Authorization: Bearer <DISPATCH_SECRET>        daily re-verification (pg_cron via pg_net)
//   200 { checked, failed }   every verified domain re-checked; three failures in a row disable one
// A deployment can react to a status change and to the end of the daily re-check (extensions.ts).
import type { DomainStatus, DomainStatusChange } from './extensions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9.-]{1,253}$/;
/**
 * What api.add_custom_domain accepts (private.normalize_hostname): two or more labels of at most 63
 * characters, a letter-initial TLD, so never an IP literal. A name that cannot match is refused
 * before the database is asked: the TLS layer's `ask` is reachable by anyone who can open a TLS
 * handshake with any server name.
 */
const PLAUSIBLE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_MAX = 2000;

export interface DomainToCheck {
  id: string;
  org_id: string;
  hostname: string;
  verification_token: string;
  status: DomainStatus;
}

export class NotSignedInError extends Error {}
export class ResolverError extends Error {}

export interface DomainCheckDeps {
  /** api.resolve_custom_domain: the location slug of a verified host, else null. */
  resolve(host: string): Promise<string | null>;
  /** The domain if the caller's JWT may manage it (RLS: owner/admin of its org), else null. */
  findForCaller(jwt: string, domainId: string): Promise<DomainToCheck | null>;
  /** Every verified domain, for the daily re-check. */
  listVerified(): Promise<DomainToCheck[]>;
  /** api.record_domain_check */
  record(domainId: string, ok: boolean): Promise<string>;
  /** TXT values at `name` (DNS-over-HTTPS). An empty list means no such record; throws ResolverError if it could not ask. */
  txt(name: string): Promise<string[]>;
  /** extensions.ts `onDomainStatusChange`. Optional so a test can leave it out. */
  onStatusChange?(change: DomainStatusChange): Promise<void>;
  /** extensions.ts `onRecheckComplete`. */
  onRecheckComplete?(verifiedHostnames: readonly string[]): Promise<void>;
  /** DISPATCH_SECRET; shorter than 32 characters means nobody may run the re-check. */
  secret: string;
  log?(message: string): void;
  /** Milliseconds, for the negative answer cache. Tests pass a fake. */
  now?(): number;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Host header or `ask` value to a bare lower-case hostname: no port, no trailing dot. */
function bareHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/:[0-9]+$/, '').replace(/\.$/, '');
}

export function createDomainCheckHandler(deps: DomainCheckDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  /**
   * Hosts the database recently said "not ours" (until the time in the value). Per instance and
   * best effort: a runtime that starts a fresh worker per request never hits it, and the plausibility
   * check above still applies. Dropped when a check in this instance verifies the host.
   */
  const unknown = new Map<string, number>();

  async function proven(d: DomainToCheck): Promise<boolean> {
    const values = await deps.txt(`_queue-verify.${d.hostname}`);
    return values.some((v) => v.trim() === d.verification_token);
  }

  /** Records one check and tells the deployment when the status really changed. */
  async function checkAndRecord(d: DomainToCheck): Promise<{ ok: boolean; status: string }> {
    const ok = await proven(d);
    const status = await deps.record(d.id, ok);
    if (status === 'verified') unknown.delete(d.hostname);
    if (status !== d.status && deps.onStatusChange) {
      try {
        await deps.onStatusChange({
          domainId: d.id,
          orgId: d.org_id,
          hostname: d.hostname,
          from: d.status,
          to: status as DomainStatus,
        });
      } catch (e) {
        log(`status hook failed for ${d.id}: ${String(e)}`);
      }
    }
    return { ok, status };
  }

  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'GET') {
      const query = new URL(req.url).searchParams;
      const host = bareHost(query.get('host') ?? query.get('domain') ?? '');
      if (!HOST.test(host) || !PLAUSIBLE.test(host)) return json(404, { error: 'not_found' });
      const until = unknown.get(host);
      if (until !== undefined && until > now()) return json(404, { error: 'not_found' });
      const slug = await deps.resolve(host);
      if (slug) return json(200, { location_slug: slug });
      if (unknown.size >= NEGATIVE_MAX) unknown.delete(unknown.keys().next().value as string);
      unknown.set(host, now() + NEGATIVE_TTL_MS);
      return json(404, { error: 'not_found' });
    }
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
    if (!bearer) return json(401, { error: 'not_authenticated' });

    try {
      if (deps.secret.length >= 32 && sameKey(bearer, deps.secret)) {
        let checked = 0;
        let failed = 0;
        for (const d of await deps.listVerified()) {
          const { ok } = await checkAndRecord(d);
          checked++;
          if (!ok) failed++;
        }
        if (deps.onRecheckComplete) {
          try {
            await deps.onRecheckComplete((await deps.listVerified()).map((d) => d.hostname));
          } catch (e) {
            log(`recheck hook failed: ${String(e)}`);
          }
        }
        log(`recheck: ${checked} checked, ${failed} failed`);
        return json(200, { checked, failed });
      }

      const body = (await req.json().catch(() => null)) as { domain_id?: unknown } | null;
      const id = typeof body?.domain_id === 'string' ? body.domain_id : '';
      if (!UUID.test(id)) return json(400, { error: 'invalid_input' });
      const domain = await deps.findForCaller(bearer, id);
      if (!domain) return json(404, { error: 'not_found' });
      const { status } = await checkAndRecord(domain);
      return json(200, { status });
    } catch (e) {
      if (e instanceof NotSignedInError) return json(401, { error: 'not_authenticated' });
      if (e instanceof ResolverError) return json(502, { error: 'unavailable' });
      throw e;
    }
  };
}
