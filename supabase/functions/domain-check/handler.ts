// 3-DOM1 (#370): domain-check. Answers "is this hostname ours, and which location does it serve?"
// for the TLS layer (Caddy on-demand TLS `ask`, Cloudflare custom hostnames) and the SPA, and proves
// ownership of a hostname with a DNS TXT record. An Edge Function because only it resolves DNS
// (technical-design.md 3.5, rule 3: it adds a capability). The gateway's JWT check is off; each
// route carries its own gate.
//
// GET  ?host=<hostname>                       public (Caddy `ask` compatible)
//   200 { location_slug }  only for a verified hostname of an active org
//   404 { error: "not_found" }  anything else, with no hint why
// POST { domain_id }  Authorization: Bearer <user JWT>   an owner or admin of the domain's org
//   200 { status }          checked _queue-verify.<host> TXT for the domain's token
//   401 not signed in · 404 unknown or foreign domain · 502 DNS resolver unreachable (no strike)
// POST {}  Authorization: Bearer <DISPATCH_SECRET>        daily re-verification (pg_cron via pg_net)
//   200 { checked, failed }   every verified domain re-checked; three failures in a row disable one
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9.-]{1,253}$/;

export interface DomainToCheck {
  id: string;
  hostname: string;
  verification_token: string;
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
  /** DISPATCH_SECRET; shorter than 32 characters means nobody may run the re-check. */
  secret: string;
  log?(message: string): void;
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

  async function proven(d: DomainToCheck): Promise<boolean> {
    const values = await deps.txt(`_queue-verify.${d.hostname}`);
    return values.some((v) => v.trim() === d.verification_token);
  }

  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'GET') {
      const host = bareHost(new URL(req.url).searchParams.get('host') ?? '');
      if (!HOST.test(host)) return json(404, { error: 'not_found' });
      const slug = await deps.resolve(host);
      return slug ? json(200, { location_slug: slug }) : json(404, { error: 'not_found' });
    }
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
    if (!bearer) return json(401, { error: 'not_authenticated' });

    try {
      if (deps.secret.length >= 32 && sameKey(bearer, deps.secret)) {
        let checked = 0;
        let failed = 0;
        for (const d of await deps.listVerified()) {
          const ok = await proven(d);
          await deps.record(d.id, ok);
          checked++;
          if (!ok) failed++;
        }
        log(`recheck: ${checked} checked, ${failed} failed`);
        return json(200, { checked, failed });
      }

      const body = (await req.json().catch(() => null)) as { domain_id?: unknown } | null;
      const id = typeof body?.domain_id === 'string' ? body.domain_id : '';
      if (!UUID.test(id)) return json(400, { error: 'invalid_input' });
      const domain = await deps.findForCaller(bearer, id);
      if (!domain) return json(404, { error: 'not_found' });
      const status = await deps.record(domain.id, await proven(domain));
      return json(200, { status });
    } catch (e) {
      if (e instanceof NotSignedInError) return json(401, { error: 'not_authenticated' });
      if (e instanceof ResolverError) return json(502, { error: 'unavailable' });
      throw e;
    }
  };
}
