// #479 follow-up: unsubscribe. Stops a venue's email to the address an outbox row went to, from
// the "Not you? Stop these emails" link (via the /u confirm page) or a mail client's RFC 8058
// one-click POST. An Edge Function because only it holds UNSUBSCRIBE_SECRET and the service role
// (technical-design.md 3.5, rule 3). The gateway's JWT check is off; the signed link is the gate.
//
// POST ?n=<outbox id>&t=<token>   (or a JSON body { n, t }; any other body is ignored)
//   200 { status: "unsubscribed" }   also when it already was
//   400 { error: "invalid_input" }   missing, malformed or tampered link; nothing is written
//   405 { error: "invalid_input" }   GET and friends: link scanners must not unsubscribe anyone
//   500 { error: "unknown" }
import { isUnsubscribeToken } from '../_shared/unsubscribe-token.ts';

export interface UnsubscribeDeps {
  /** api.unsubscribe_outbox */
  unsubscribe(outboxId: string): Promise<void>;
  /** UNSUBSCRIBE_SECRET */
  secret: string;
  /** UNSUBSCRIBE_SECRET_PREVIOUS: links signed before a rotation keep working (CAN-SPAM: 30 days). */
  previousSecret?: string;
  log?(message: string): void;
  /** A failure worth an error report (`cause` stays out of it); defaults to `log`. */
  error?(line: string, cause: unknown): void;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function linkParams(req: Request): Promise<{ n: string; t: string }> {
  const url = new URL(req.url);
  let n = url.searchParams.get('n') ?? '';
  let t = url.searchParams.get('t') ?? '';
  if ((!n || !t) && req.headers.get('content-type')?.includes('application/json')) {
    const body = await req.json().catch(() => null);
    n = typeof body?.n === 'string' ? body.n : n;
    t = typeof body?.t === 'string' ? body.t : t;
  }
  return { n, t };
}

export function createUnsubscribeHandler(deps: UnsubscribeDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const error = deps.error ?? ((line: string, cause: unknown) => log(`${line}: ${String(cause)}`));
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });
    const { n, t } = await linkParams(req);
    const valid =
      UUID.test(n) &&
      ((await isUnsubscribeToken(deps.secret, n, t)) ||
        (deps.previousSecret !== undefined && (await isUnsubscribeToken(deps.previousSecret, n, t))));
    if (!valid) {
      return json(400, { error: 'invalid_input' });
    }
    try {
      await deps.unsubscribe(n);
    } catch (failure) {
      error(`unsubscribe ${n} failed`, failure);
      return json(500, { error: 'unknown' });
    }
    log(`unsubscribe ${n} done`);
    return json(200, { status: 'unsubscribed' });
  };
}
