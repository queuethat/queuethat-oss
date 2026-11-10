// 2P-NTF10 (#182): dev-sms-inbound. Lets a staff member type a reply as a guest's phone ("STOP",
// "HELP") so two-way SMS can be built before a provider is paid for. It is an Edge Function only
// because it holds the switch: it answers 404 unless DEV_INBOX_ENABLED=true, so a deployment
// that never sets that variable has no way to inject replies. Everything else is in
// api.dev_record_inbound (service role), which checks the caller is staff of the org.
//
// POST { org_id, from_e164, body }   Authorization: Bearer <user JWT>
//   200 { action }   stop | help | stored
//   400 invalid_input · 401 not_authenticated · 404 not_found (also when disabled)
// Logs carry fixed words only: never the number or the message.

export interface DevSmsInboundDeps {
  /** True only when DEV_INBOX_ENABLED=true. */
  enabled: boolean;
  /** The user id behind the JWT, or null when it is invalid or expired. */
  authenticate(jwt: string): Promise<string | null>;
  /** api.dev_record_inbound as the service role. Throws an Error whose message is the db code. */
  record(orgId: string, actor: string, fromE164: string, body: string): Promise<string>;
  log?(line: string, cause: unknown): void;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const STATUS: Record<string, number> = { invalid_input: 400, not_found: 404 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function createDevSmsInboundHandler(deps: DevSmsInboundDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});

  return async (req) => {
    // Disabled means indistinguishable from a function that does not exist, before anything is read.
    if (!deps.enabled) return json(404, { error: 'not_found' });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const jwt = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const actor = jwt ? await deps.authenticate(jwt).catch(() => null) : null;
    if (!actor) return json(401, { error: 'not_authenticated' });

    const input = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (
      !input || typeof input.org_id !== 'string' || !UUID.test(input.org_id) ||
      typeof input.from_e164 !== 'string' || typeof input.body !== 'string'
    ) {
      return json(400, { error: 'invalid_input' });
    }
    try {
      return json(200, { action: await deps.record(input.org_id, actor, input.from_e164, input.body) });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!(code in STATUS)) log('dev_record_inbound failed', error);
      return json(STATUS[code] ?? 500, { error: code in STATUS ? code : 'unknown' });
    }
  };
}
