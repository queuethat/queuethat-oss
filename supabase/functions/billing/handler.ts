// 4-BILL1 (#377): the billing function. An Edge Function because only it holds the platform's Stripe
// keys and the service role (technical-design.md 3.5, rule 3). Stripe is the source of truth for
// subscription state; the database applies it in order (api.apply_billing_event) and decides what
// quantity the org's locations call for (api.claim_billing_jobs).
//
// POST /webhook   Stripe-Signature (verified before any database call)
//   200 { applied, ignored, rejected }   one count per event; replays are harmless
//   400 { error: "invalid_signature" }   bad, stale or missing signature; nothing is written
//   500 { error: "unknown" }             a database failure; Stripe retries
// POST /jobs      Authorization: Bearer <DISPATCH_SECRET> (as dispatch-notifications)
//   200 { claimed, done, failed }
// POST /portal | /checkout | /topup   Authorization: Bearer <the owner's JWT>, body {org_id}
//   /checkout also takes interval, 'month' (default) or 'year': which of the plan's two Stripe Prices
//   200 { url }                 Stripe Customer Portal or subscription Checkout; redirect the browser there
//   400 invalid_input · 401 unauthorized · 403 permission_denied (only the org's owner) · 404 not_found
//   (billing off) · 409 no_customer (portal before any subscription) or already_subscribed (checkout)
//   503 price_not_configured · 502 provider
//   /topup also takes amount_minor, one of TOPUP_AMOUNTS (400 invalid_input otherwise): SMS credit, never automatic
// The return address is always our own PUBLIC_URL, never taken from the request.
// 405 for any other method, 404 for any other route.
import { type BillingEvent, type BillingProvider, PaymentError } from '@qm/providers';
import { constantTimeEqual } from '../_shared/hmac.ts';

export interface BillingJob {
  id: string;
  org_id: string;
  stripe_subscription_id: string;
  quantity: number;
  attempts: number;
}

export type BillingReport = { ok: true; quantity: number } | { ok: false; retryable: boolean; code: string };

/** What the database says about the caller's access to the org's billing (api.billing_session_info). */
export interface SessionInfo {
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  quantity: number;
}

/** A refusal from the database, as the code the client sees. */
export class SessionError extends Error {
  constructor(readonly code: 'unauthorized' | 'permission_denied' | 'not_found') {
    super(code);
  }
}

export interface BillingDeps {
  provider: BillingProvider;
  /** DISPATCH_SECRET */
  secret: string;
  /** api.apply_billing_event: applied, ignored, org_mismatch or unknown_subscription. */
  apply(event: BillingEvent): Promise<string>;
  /** api.claim_billing_jobs */
  claim(limit: number, leaseSeconds: number): Promise<BillingJob[]>;
  /** api.report_billing_result */
  report(jobId: string, result: BillingReport): Promise<void>;
  /** api.billing_session_info under the caller's own JWT. Throws SessionError. */
  sessionInfo(token: string, orgId: string, interval: 'month' | 'year'): Promise<SessionInfo>;
  /** PUBLIC_URL: where Stripe sends the owner back to, and the only browser origin allowed. */
  publicUrl: string;
  log?(line: string): void;
  error?(line: string, cause: unknown): void;
}

const MAX_BODY_BYTES = 256 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function webhook(req: Request, deps: BillingDeps): Promise<Response> {
  // Bodies are a few KB; refuse a big one before reading it (the signature needs the whole body).
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  let events: BillingEvent[];
  try {
    events = await deps.provider.parseWebhook(req);
  } catch {
    return json(400, { error: 'invalid_signature' });
  }
  const tally = { applied: 0, ignored: 0, rejected: 0 };
  try {
    for (const event of events) {
      const result = await deps.apply(event);
      // A paid bundle for a subscription we haven't stored yet (its own event is still on the way) must be
      // retried by Stripe, not dropped: only our bundle price reaches here, so no other integration can loop.
      if (event.type === 'bundle_paid' && result === 'unknown_subscription') throw new Error('bundle_subscription_unknown');
      if (result === 'applied') tally.applied++;
      else if (result === 'ignored') tally.ignored++;
      else {
        tally.rejected++;
        // A subscription we don't know may belong to another integration on the same Stripe account.
        deps.log?.(`billing ${event.type}: ${result}`);
      }
    }
  } catch (cause) {
    (deps.error ?? ((line: string) => deps.log?.(line)))('billing webhook failed', cause);
    return json(500, { error: 'unknown' });
  }
  return json(200, tally);
}

async function runOne(job: BillingJob, deps: BillingDeps): Promise<'done' | 'failed'> {
  let report: BillingReport;
  try {
    // Job id and quantity are the idempotency key: a retry repeats the call, a changed quantity is a new one.
    const r = await deps.provider.setQuantity(job.stripe_subscription_id, job.quantity, `${job.id}:${job.quantity}`);
    report = { ok: true, quantity: r.quantity };
  } catch (failure) {
    // The code only: provider messages can carry customer or subscription ids.
    report = failure instanceof PaymentError
      ? { ok: false, retryable: failure.retryable, code: failure.code }
      : { ok: false, retryable: true, code: 'unknown' };
  }
  try {
    await deps.report(job.id, report);
  } catch (cause) {
    // the lease expires and the job runs again; the rest of the batch still goes
    (deps.error ?? ((line: string) => deps.log?.(line)))('billing report failed', cause);
    return 'failed';
  }
  return report.ok ? 'done' : 'failed';
}

async function jobs(req: Request, deps: BillingDeps): Promise<Response> {
  const auth = req.headers.get('Authorization') ?? '';
  if (deps.secret.length < 32 || !constantTimeEqual(auth, `Bearer ${deps.secret}`)) {
    return json(401, { error: 'unauthorized' });
  }
  const claimed = await deps.claim(20, 120);
  const tally = { claimed: claimed.length, done: 0, failed: 0 };
  for (const job of claimed) tally[await runOne(job, deps)]++;
  deps.log?.(`billing jobs ${JSON.stringify(tally)}`);
  return json(200, tally);
}

/** The top-up amounts offered, in USD minor units. */
export const TOPUP_AMOUNTS = [1000, 2500, 5000];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = { unauthorized: 401, permission_denied: 403, not_found: 404 } as const;

async function session(req: Request, deps: BillingDeps, kind: 'portal' | 'checkout' | 'topup'): Promise<Response> {
  const token = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!token) return json(401, { error: 'unauthorized' });
  const body = (await req.json().catch(() => null)) as { org_id?: unknown; amount_minor?: unknown; interval?: unknown } | null;
  if (typeof body?.org_id !== 'string' || !UUID.test(body.org_id)) return json(400, { error: 'invalid_input' });
  const orgId = body.org_id;
  const interval = body.interval ?? 'month';
  if (interval !== 'month' && interval !== 'year') return json(400, { error: 'invalid_input' });
  const returnUrl = `${deps.publicUrl.replace(/\/+$/, '')}/admin/billing`;
  try {
    const info = await deps.sessionInfo(token, orgId, interval);
    if (kind === 'topup') {
      const amount = body.amount_minor;
      if (typeof amount !== 'number' || !TOPUP_AMOUNTS.includes(amount)) return json(400, { error: 'invalid_input' });
      return json(
        200,
        await deps.provider.createTopUpSession({
          orgId,
          amountMinor: amount,
          returnUrl,
          idempotencyKey: `topup:${orgId}:${amount}:${Math.floor(Date.now() / 300_000)}`,
        }),
      );
    }
    if (kind === 'portal') {
      if (!info.customerId) return json(409, { error: 'no_customer' });
      return json(200, await deps.provider.createPortalSession(info.customerId, returnUrl));
    }
    if (info.subscriptionId) return json(409, { error: 'already_subscribed' });
    if (!info.priceId) return json(503, { error: 'price_not_configured' });
    return json(
      200,
      await deps.provider.createCheckoutSession({
        orgId,
        customerId: info.customerId,
        priceId: info.priceId,
        quantity: info.quantity,
        returnUrl,
        // one Checkout per org and quantity for a few minutes, so a double click opens the same page
        idempotencyKey: `${orgId}:${interval}:${info.quantity}:${Math.floor(Date.now() / 300_000)}`,
      }),
    );
  } catch (cause) {
    if (cause instanceof SessionError) return json(STATUS[cause.code], { error: cause.code });
    (deps.error ?? ((line: string) => deps.log?.(line)))(`billing ${kind} failed`, cause);
    return json(502, { error: 'provider' });
  }
}

function cors(req: Request, deps: BillingDeps): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowed = deps.publicUrl.replace(/\/+$/, '');
  return {
    'Access-Control-Allow-Origin': origin === allowed ? allowed : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function createBillingHandler(deps: BillingDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
    const browser = route === 'portal' || route === 'checkout' || route === 'topup';
    if (!browser && route !== 'webhook' && route !== 'jobs') return json(404, { error: 'not_found' });
    if (browser && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, deps) });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (route === 'webhook') return webhook(req, deps);
    if (route === 'jobs') return jobs(req, deps);
    const res = await session(req, deps, route);
    for (const [k, v] of Object.entries(cors(req, deps))) res.headers.set(k, v);
    return res;
  };
}
