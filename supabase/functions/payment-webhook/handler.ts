// V-4 (#318): payment provider webhook. An Edge Function because only it holds the webhook
// secret and the service role (technical-design.md 3.5, rule 3). The gateway's JWT check is off;
// the provider's signature is the gate and is verified before any database call.
//
// POST  (Stripe-Signature for Stripe)
//   200 { recorded, duplicate }   every event stored once; replays are no-ops
//   400 { error: "invalid_signature" }   bad, stale or missing signature; nothing is written
//   405                           anything but POST
//   503 { error: "unknown_hold" } an event for a hold we haven't stored yet; the provider retries
//   500 { error: "unknown" }
import type { PaymentEvent, PaymentProvider } from '@qm/providers';

export interface PaymentWebhookDeps {
  provider: Pick<PaymentProvider, 'providerName' | 'parseWebhook'>;
  /** api.record_payment_event */
  record(providerName: string, event: PaymentEvent): Promise<'recorded' | 'duplicate' | 'unknown_hold'>;
  log?(message: string): void;
  error?(line: string, cause: unknown): void;
}

const MAX_BODY_BYTES = 64 * 1024;
// An event for a hold we still don't know after this long isn't ours (another integration on the
// same account): acknowledge it, or the provider retries it forever and may disable the endpoint.
const UNKNOWN_HOLD_GRACE_MS = 10 * 60 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function createPaymentWebhookHandler(deps: PaymentWebhookDeps): (req: Request) => Promise<Response> {
  const error = deps.error ?? ((line: string) => deps.log?.(line));
  return async (req) => {
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    // Bodies are a few KB; refuse a big one before reading it (the signature needs the whole body).
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
    let events: PaymentEvent[];
    try {
      events = await deps.provider.parseWebhook(req);
    } catch {
      return json(400, { error: 'invalid_signature' });
    }
    try {
      const counts = { recorded: 0, duplicate: 0 };
      let unknown = false;
      for (const event of events) {
        const result = await deps.record(deps.provider.providerName, event);
        if (result === 'unknown_hold') {
          if (Date.now() - Date.parse(event.at) < UNKNOWN_HOLD_GRACE_MS) unknown = true;
        } else counts[result]++;
      }
      return unknown ? json(503, { error: 'unknown_hold' }) : json(200, counts);
    } catch (cause) {
      error('payment-webhook failed', cause);
      return json(500, { error: 'unknown' });
    }
  };
}
