// 3-CG2 (#327): provider-webhook. Every inbound provider request (Twilio, Stripe, Meta) lands here:
// read the raw bytes, look up the endpoint's signing secrets (a read), verify, and only then record
// the event once and hand it to the provider's handler. An invalid request never touches the
// database beyond the secret read. The gateway's JWT check is off; the signature is the gate.
//
// POST|GET {PUBLIC_FUNCTIONS_URL}/provider-webhook/{provider}/{endpoint_id}
//   200 {status:"ok"}              verified; a replayed event is a 200 that does no work
//   403 {error:"mismatch"|"stale"}   bad or absent signature, or an unknown endpoint ("mismatch")
//   404 {error:"not_found"}        unknown provider or malformed route
//   413 {error:"invalid_input"}    body over 1 MB
// A handler failure is stored in webhook_events.error and still answered 200, so the provider's
// retry (a duplicate) does not run it twice; ops reads the error column.
import { metaHandshake } from './verify/meta.ts';
import { verifiers as defaultVerifiers } from './verify/index.ts';
import type { WebhookVerifier } from './verify/types.ts';

export interface EndpointSecrets {
  orgId: string | null;
  /** Signing secrets, newest first; every one is tried so a rotation has no gap. */
  secrets: string[];
  /** Meta's GET handshake token. */
  verifyToken?: string;
}

export interface WebhookContext {
  provider: string;
  orgId: string | null;
  eventId: number;
  eventKey: string;
  /** The provider re-sent an event already recorded; only an inline handler runs for it, and it must not apply the event twice. */
  isDuplicate?: boolean;
  rawBody: Uint8Array;
  form?: URLSearchParams;
  /** The query string of the verified request: part of the signed URL, so only we could have written it. */
  query?: URLSearchParams;
  /** The route as the provider was told to call it, without the query string. */
  selfUrl?: string;
}
/** What a call-control provider (Twilio Voice) expects back in place of {status:"ok"}. */
export interface WebhookReply {
  body: string;
  contentType: string;
}
/** Handlers enqueue outbox rows; they never call a provider directly. Only an `inlineResponse` verifier's handler replies. */
export type WebhookHandler = (ctx: WebhookContext) => Promise<void | WebhookReply>;

export interface ProviderWebhookDeps {
  /** api.get_webhook_secret; null for an unknown endpoint. */
  endpointSecrets(provider: string, endpointId: string): Promise<EndpointSecrets | null>;
  /** api.record_webhook_event */
  record(provider: string, eventKey: string, orgId: string | null, payload: unknown): Promise<{ eventId: number; isDuplicate: boolean }>;
  /** api.mark_webhook_processed */
  markProcessed(eventId: number, error?: string): Promise<void>;
  /** Per provider; a provider with none only has its events recorded. */
  handlers: Record<string, WebhookHandler>;
  /** PUBLIC_FUNCTIONS_URL, e.g. https://x.supabase.co/functions/v1: what the provider was told to call. */
  publicFunctionsUrl: string;
  verifiers?: Record<string, WebhookVerifier>;
  now?: () => Date;
  log?(message: string): void;
  error?(line: string, cause: unknown): void;
}

const MAX_BODY = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function route(url: URL): { provider: string; endpointId: string } | null {
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('provider-webhook');
  const [provider, endpointId, extra] = parts.slice(i + 1);
  if (i < 0 || !provider || !endpointId || extra !== undefined || !UUID.test(endpointId)) return null;
  return { provider, endpointId };
}

export function createProviderWebhookHandler(deps: ProviderWebhookDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const error = deps.error ?? ((line: string, cause: unknown) => log(`${line}: ${String(cause)}`));
  const verifiers = deps.verifiers ?? defaultVerifiers;
  const now = deps.now ?? (() => new Date());
  const base = deps.publicFunctionsUrl.replace(/\/+$/, '');

  return async (req) => {
    const url = new URL(req.url);
    const r = route(url);
    const verifier = r && Object.hasOwn(verifiers, r.provider) ? verifiers[r.provider] : undefined;
    if (!r || !verifier) return json(404, { error: 'not_found' });
    const { provider, endpointId } = r;
    const tag = `${provider}/${endpointId}`;
    const publicUrl = `${base}/provider-webhook/${provider}/${endpointId}${url.search}`;

    // Refuse oversized bodies before any lookup or buffering.
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json(413, { error: 'invalid_input' });
    const endpoint = await deps.endpointSecrets(verifier.secretsProvider ?? provider, endpointId);

    // Meta's subscription handshake is a GET with no body to sign.
    if (req.method === 'GET') {
      const challenge = provider === 'meta' && endpoint ? metaHandshake(url.searchParams, endpoint.verifyToken) : null;
      if (challenge === null) {
        log(`webhook ${tag} handshake rejected`);
        return json(403, { error: 'mismatch' });
      }
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (req.method !== 'POST') return json(404, { error: 'not_found' });

    const rawBody = new Uint8Array(await req.arrayBuffer());
    if (rawBody.length > MAX_BODY) return json(413, { error: 'invalid_input' });
    const isForm = req.headers.get('content-type')?.toLowerCase().includes('application/x-www-form-urlencoded');
    const form = isForm ? new URLSearchParams(new TextDecoder().decode(rawBody)) : undefined;

    // Unknown endpoint and bad signature answer alike: no oracle for endpoint ids.
    const failures: string[] = [];
    let verified = false;
    for (const secret of endpoint?.secrets ?? []) {
      const result = await verifier.verify({ rawBody, headers: req.headers, publicUrl, form }, secret, now());
      if (result.ok) {
        verified = true;
        break;
      }
      failures.push(result.reason);
    }
    // Only `stale` (which needs the right secret) is told apart; an absent header, a wrong one and
    // an unknown endpoint all answer `mismatch`.
    const reason = failures.includes('stale') ? 'stale' : 'mismatch';
    if (!verified || !endpoint) {
      log(`webhook ${tag} rejected: ${reason}`);
      return json(403, { error: reason });
    }

    let payload: unknown = null;
    if (form) payload = Object.fromEntries(form);
    // The platform number's events carry guests' phone numbers and texts; keep only what ops needs (I-13).
    if (provider === 'twilio-platform' && form) {
      payload = Object.fromEntries(
        ['MessageSid', 'MessageStatus', 'ErrorCode', 'OptOutType'].flatMap((k) => (form.has(k) ? [[k, form.get(k)]] : [])),
      );
    }
    else {
      try {
        payload = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        payload = null;
      }
    }

    const handler = Object.hasOwn(deps.handlers, provider) ? deps.handlers[provider] : undefined;
    const selfUrl = publicUrl.slice(0, publicUrl.length - url.search.length);
    let reply: WebhookReply | undefined;
    for (const eventKey of verifier.eventKeys(rawBody, form, req.headers)) {
      // Keys are scoped to the endpoint: another org's valid endpoint cannot pre-empt this one's ids.
      const { eventId, isDuplicate } = await deps.record(provider, `${endpointId}:${eventKey}`, endpoint.orgId, payload);
      // A call is a conversation: a retried request still needs its answer, so an inline handler
      // (idempotent by design) runs again for a replay.
      if (isDuplicate && !verifier.inlineResponse) continue;
      let failure: string | undefined;
      try {
        const result = await handler?.({ provider, orgId: endpoint.orgId, eventId, eventKey, isDuplicate, rawBody, form, query: url.searchParams, selfUrl });
        if (result) reply = result;
      } catch (cause) {
        failure = cause instanceof Error ? cause.name : 'error';
        error(`webhook ${tag} handler failed`, cause);
      }
      if (!isDuplicate) await deps.markProcessed(eventId, failure);
    }
    if (verifier.inlineResponse) {
      // Never leave the caller in silence: a failed handler says so and hangs up.
      const out = reply ?? { body: verifier.failureReply ?? '', contentType: 'text/xml' };
      return new Response(out.body, { status: 200, headers: { 'Content-Type': out.contentType, 'Cache-Control': 'no-store' } });
    }
    return json(200, { status: 'ok' });
  };
}
