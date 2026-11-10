// 3-PAY3 (#364): payment-jobs. Runs queued captures, releases, refunds and no-show charges, the way
// the notification dispatcher runs the outbox: claim with a lease, call the provider with the job id
// as idempotency key (so a retry or a double invocation can't act twice), report, back off.
// An Edge Function because only it holds the provider key (technical-design.md 3.5, rule 3).
//
// POST (Authorization: Bearer <DISPATCH_SECRET>, as dispatch-notifications) -> 200 tally
import { PaymentError, type PaymentProvider, type PaymentResult } from '@qm/providers';
import { constantTimeEqual } from '../_shared/hmac.ts';

export interface PaymentJob {
  id: string;
  org_id: string;
  payment_id: string;
  action: 'capture' | 'release' | 'refund' | 'charge_no_show';
  amount_minor: number | null;
  attempts: number;
}

export interface StoredPayment {
  kind: 'hold' | 'deposit' | 'card_on_file' | 'no_show_fee';
  intent_id: string | null;
  customer_id: string | null;
  payment_method_id: string | null;
  amount_minor: number;
  currency: string;
  org_id: string;
}

export type PaymentReport =
  | { ok: true; status: string; intent_id?: string }
  | { ok: false; retryable: boolean; code: string };

export interface PaymentJobsDeps {
  provider: PaymentProvider;
  secret: string;
  claim(limit: number, leaseSeconds: number): Promise<PaymentJob[]>;
  payment(id: string): Promise<StoredPayment | null>;
  report(jobId: string, result: PaymentReport): Promise<void>;
  log?(line: string): void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function perform(job: PaymentJob, p: StoredPayment, provider: PaymentProvider): Promise<PaymentResult> {
  // The job id is the idempotency key, so the provider sees one effect however often this runs.
  const key = job.id;
  if (job.action === 'release') return provider.release(need(p.intent_id), key);
  if (job.action === 'refund') return provider.refund(need(p.intent_id), job.amount_minor ?? undefined, key);
  if (p.kind === 'card_on_file') {
    return provider.chargeSavedCard({
      orgId: p.org_id,
      paymentMethodId: need(p.payment_method_id),
      customerId: need(p.customer_id),
      amountMinor: job.amount_minor ?? p.amount_minor,
      currency: p.currency,
      idempotencyKey: key,
    });
  }
  return provider.capture(need(p.intent_id), job.amount_minor ?? undefined, key);
}

function need(value: string | null): string {
  if (!value) throw new PaymentError('missing_prerequisite', false);
  return value;
}

async function runOne(job: PaymentJob, deps: PaymentJobsDeps): Promise<'done' | 'failed'> {
  let report: PaymentReport;
  try {
    const p = await deps.payment(job.payment_id);
    if (!p) throw new PaymentError('payment_missing', false);
    const r = await perform(job, p, deps.provider);
    report = { ok: true, status: r.status, intent_id: r.intentId };
  } catch (failure) {
    // The code only: provider messages can carry customer or payment ids.
    report = failure instanceof PaymentError
      ? { ok: false, retryable: failure.retryable, code: failure.code }
      : { ok: false, retryable: true, code: 'unknown' };
  }
  await deps.report(job.id, report);
  return report.ok ? 'done' : 'failed';
}

export function createPaymentJobsHandler(deps: PaymentJobsDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const auth = req.headers.get('Authorization') ?? '';
    if (deps.secret.length < 32 || !constantTimeEqual(auth, `Bearer ${deps.secret}`)) {
      return json(401, { error: 'unauthorized' });
    }
    const jobs = await deps.claim(20, 120);
    const tally = { claimed: jobs.length, done: 0, failed: 0 };
    for (const job of jobs) tally[await runOne(job, deps)]++;
    deps.log?.(`payment-jobs ${JSON.stringify(tally)}`);
    return json(200, tally);
  };
}
