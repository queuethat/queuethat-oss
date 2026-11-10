// 3-WA4 (#361): whatsapp-templates-sync. An owner or admin asks for the status of the WhatsApp
// templates they mapped; this reads the WABA's templates from Meta's Graph API and writes status
// and category-drift back onto the org's mappings. Nothing is created in Meta.
//
// POST { org_id }   Authorization: Bearer <user JWT>   (verify_jwt stays on)
//   200 {updated, missing}   400 invalid_input   401 not_authenticated   403 forbidden
//   409 not_configured (no enabled WhatsApp config)   502 unavailable (Meta did not answer)
// The mappings are read and written as the caller (RLS decides); the service role only reads the
// org's config and token, after the caller was shown to be an owner or admin. Logs carry ids and
// fixed words, never the token.
export interface Mapping {
  id: string;
  wa_name: string;
  wa_language: string;
  wa_category: 'utility' | 'marketing';
}
export interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
}
export interface SyncDeps {
  /** True when the caller's JWT belongs to an owner or admin of the org. */
  isAdmin(jwt: string, orgId: string): Promise<boolean>;
  /** The org's WhatsApp config (waba_id, access_token, graph_version), or null when not enabled. */
  config(orgId: string): Promise<{ wabaId: string; accessToken: string; graphVersion: string } | null>;
  /** The org's mappings as the caller. */
  mappings(jwt: string, orgId: string): Promise<Mapping[]>;
  /** All message templates of the WABA (paged), or throws. */
  metaTemplates(wabaId: string, accessToken: string, graphVersion: string): Promise<MetaTemplate[]>;
  /** Writes one mapping's status as the caller. */
  setStatus(jwt: string, id: string, status: string): Promise<void>;
  log?(line: string, cause?: unknown): void;
}

const STATUS: Record<string, string> = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'paused',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  PENDING_DELETION: 'paused',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function createSyncHandler(deps: SyncDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });
    const jwt = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!jwt) return json(401, { error: 'not_authenticated' });
    const body = (await req.json().catch(() => null)) as { org_id?: unknown } | null;
    const orgId = body?.org_id;
    if (typeof orgId !== 'string' || !UUID.test(orgId)) return json(400, { error: 'invalid_input' });
    try {
      if (!(await deps.isAdmin(jwt, orgId))) return json(403, { error: 'forbidden' });
      const config = await deps.config(orgId);
      if (!config) return json(409, { error: 'not_configured' });
      const mappings = await deps.mappings(jwt, orgId);
      let theirs: MetaTemplate[];
      try {
        theirs = await deps.metaTemplates(config.wabaId, config.accessToken, config.graphVersion);
      } catch (cause) {
        log('whatsapp-templates-sync: meta unavailable', String(cause).replaceAll(config.accessToken, '***'));
        return json(502, { error: 'unavailable' });
      }
      let updated = 0;
      let missing = 0;
      for (const m of mappings) {
        const t = theirs.find((x) => x.name === m.wa_name && x.language === m.wa_language);
        if (!t) {
          missing++;
          continue;
        }
        // Meta re-categorised it: it no longer matches what we mapped, so it must not be used.
        const status = t.category.toLowerCase() === m.wa_category ? (STATUS[t.status] ?? 'pending') : 'paused';
        await deps.setStatus(jwt, m.id, status);
        updated++;
      }
      return json(200, { updated, missing });
    } catch (cause) {
      log('whatsapp-templates-sync: failed', cause instanceof Error ? cause.name : 'error');
      return json(500, { error: 'unknown' });
    }
  };
}
