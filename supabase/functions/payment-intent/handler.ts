// 3-PAY3 (#364): payment-intent. A guest holding a visit or appointment link token starts the
// payment the service's policy asks for and gets the client secret for Stripe's Payment Element.
// An Edge Function because only it holds the provider key and the service role (technical-design.md
// 3.5, rule 3). The client never sends an amount: the database resolves it from the policy.
//
// POST { token, idempotency_key }
//   200 { payment_id, kind, amount_minor, currency, cancel_cutoff_hours, release_after, client_secret,
//         publishable_key }  (the policy fields are what the guest sees before entering a card)
// POST { token, pos: true }  (the guest's status page asking whether staff requested a counter payment)
//   same answer with kind 'pos' and a charge that captures at once; 200 { none: true } when none is open
//   (not a 409: the page asks every few seconds and a 4xx is logged by the browser each time)
// POST { code }  (the pay page a staff tablet QR opens, 4-PAY2: a short code instead of a link token)
//   same answer as pos; 404 not_found for an unknown, expired, replaced or already-paid code (all alike)
//   400 invalid_input   404 not_found (unknown token, as the status endpoint)   409 payment_not_required
//   429 rate_limited    500 unknown
import type { PaymentProvider } from '@qm/providers';

export interface PaymentPlan {
  payment_id: string;
  org_id: string;
  kind: 'hold' | 'deposit' | 'card_on_file' | 'pos';
  amount_minor: number;
  currency: string;
  ref_id: string;
  /** The policy snapshot stored on the payment, shown to the guest before they enter a card. */
  cancel_cutoff_hours: number;
  release_after: string;
}

/** api.begin_payment refused with this database error code (not_found, payment_not_required). */
export class PlanError extends Error {}

export interface PaymentIntentDeps {
  provider: PaymentProvider;
  /** Safe to show the browser (Stripe pk_...); empty for the fake. */
  publishableKey: string;
  /** api.begin_payment; throws PlanError. */
  begin(token: string, provider: string, idempotencyKey: string): Promise<PaymentPlan>;
  /** api.begin_pos_payment; throws PlanError. Never creates a payment. */
  beginPos(token: string, provider: string): Promise<PaymentPlan>;
  /** api.begin_pos_payment_by_code; throws PlanError. Never creates a payment. */
  beginPosByCode(code: string, provider: string): Promise<PaymentPlan>;
  /** api.attach_payment_intent */
  attach(paymentId: string, intentId: string | null, setupIntentId: string | null): Promise<void>;
  /** api.hit_rate_limit: true while within the limit. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** sha256 hex, so the rate-limit key never holds the token. */
  digest(value: string): Promise<string>;
  /** PUBLIC_URL: the only browser origin allowed. */
  publicUrl: string;
  error?(line: string, cause: unknown): void;
}

/** The caller's IP as the edge gateway reports it; only its hash reaches the rate-limit key. */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return req.headers.get('cf-connecting-ip') ?? (forwarded || 'unknown');
}

export function createPaymentIntentHandler(deps: PaymentIntentDeps): (req: Request) => Promise<Response> {
  const error = deps.error ?? (() => {});
  const headers = (origin: string | null) => ({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin === deps.publicUrl ? deps.publicUrl : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  });
  return async (req) => {
    const origin = req.headers.get('origin');
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { ...headers(origin), ...extra } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) });
    if (origin !== null && origin !== deps.publicUrl) return json(403, { error: 'forbidden' });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const body = await req.json().catch(() => null);
    const byCode = typeof body?.code === 'string';
    const code = byCode ? body.code.trim() : '';
    const token = typeof body?.token === 'string' ? body.token : '';
    const pos = byCode || body?.pos === true;
    const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key : '';
    // A code is typed or scanned: letters, digits and the hyphen the tablet prints between the halves.
    const badCode = byCode && !/^[0-9A-Za-z-]{8,12}$/.test(code);
    if (badCode || (!byCode && (token.length < 8 || token.length > 200 || (!pos && (key.length < 1 || key.length > 100))))) {
      return json(400, { error: 'invalid_input' });
    }
    // Any amount or currency in the body is ignored on purpose: begin() reads the policy.
    try {
      // The status page asks every few seconds while it is open, so a counter payment has its own, wider budget.
      const [bucket, limit] = byCode ? ['paycode', 30] : pos ? ['paypos', 30] : ['payint', 10];
      // Spelled the way the database reads it, so ABCD-2345, abcd2345 and look-alike variants share one bucket.
      const subject = byCode ? code.replace(/[\s-]/g, '').toUpperCase().replace(/[OIL]/g, (c: string) => (c === 'O' ? '0' : '1')) : token;
      if (!(await deps.hit(`${bucket}:${await deps.digest(subject)}`, Number(limit), 60))) {
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      }
      // Guessing codes is bounded by the caller too, not only by the code being tried: a code is short.
      // A header a client can set is only a hint, so a global bucket backs it up; with no header only the global one applies.
      const ip = clientKey(req);
      if (byCode && ((ip !== 'unknown' && !(await deps.hit(`paycodeip:${await deps.digest(ip)}`, 20, 60)))
        || !(await deps.hit('paycode:all', 300, 60)))) {
        return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      }
      const plan = byCode
        ? await deps.beginPosByCode(code, deps.provider.providerName)
        : pos
        ? await deps.beginPos(token, deps.provider.providerName)
        : await deps.begin(token, deps.provider.providerName, key);
      // The payment id is the provider idempotency key: a retry after a crash gets the same intent.
      const input = { orgId: plan.org_id, refId: plan.ref_id, idempotencyKey: plan.payment_id };
      const money = { ...input, amountMinor: plan.amount_minor, currency: plan.currency };
      let clientSecret: string;
      if (plan.kind === 'card_on_file') {
        const setup = await deps.provider.saveCard(input);
        await deps.attach(plan.payment_id, null, setup.setupIntentId);
        clientSecret = setup.clientSecret;
      } else {
        // A counter payment charges at once, like a deposit.
        const intent = plan.kind === 'hold' ? await deps.provider.createHold(money) : await deps.provider.createDeposit(money);
        await deps.attach(plan.payment_id, intent.intentId, null);
        clientSecret = intent.clientSecret;
      }
      return json(200, {
        payment_id: plan.payment_id,
        kind: plan.kind,
        amount_minor: plan.amount_minor,
        currency: plan.currency,
        cancel_cutoff_hours: plan.cancel_cutoff_hours,
        release_after: plan.release_after,
        client_secret: clientSecret,
        publishable_key: deps.publishableKey,
      });
    } catch (failure) {
      if (failure instanceof PlanError) {
        if (byCode) return json(404, { error: 'not_found' });
        if (pos && !byCode && failure.message === 'payment_not_required') return json(200, { none: true });
        return failure.message === 'payment_not_required'
          ? json(409, { error: 'payment_not_required' })
          : json(404, { error: 'not_found' });
      }
      // Logs the error code only: provider messages can carry customer ids.
      error('payment-intent failed', failure instanceof Error ? failure.name : 'unknown');
      return json(500, { error: 'unknown' });
    }
  };
}
