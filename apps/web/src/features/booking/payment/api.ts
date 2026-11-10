import { appConfig } from '../../../lib/config.ts';

// The payment step (A-13): after a booking succeeds, ask the payment-intent function whether the
// service's policy wants a card. The amount is never sent; the database resolves it from the policy.

export type PaymentKind = 'hold' | 'deposit' | 'card_on_file' | 'pos';

export interface PaymentIntentInfo {
  paymentId: string;
  kind: PaymentKind;
  amountMinor: number;
  currency: string;
  cancelCutoffHours: number;
  releaseAfter: string;
  clientSecret: string;
  /** Empty with the fake provider: no card can be collected. */
  publishableKey: string;
}

/**
 * Starts the payment for a booking by its link token. Resolves null when the service asks for no
 * payment (409 payment_not_required), so the caller goes straight to the appointment. The key makes
 * a retry after a dropped answer return the same payment.
 */
export async function requestPayment(
  token: string,
  idempotencyKey: string,
): Promise<PaymentIntentInfo | null> {
  return post({ token, idempotency_key: idempotencyKey });
}

/**
 * The payment staff asked this visit's guest to make at the counter (4-PAY1), or null while none is
 * open. The amount is whatever staff entered; the page never sends one.
 */
export async function requestPosPayment(token: string): Promise<PaymentIntentInfo | null> {
  return post({ token, pos: true });
}

/**
 * The counter payment a staff tablet's pay code opens (4-PAY2), or null when the code is unknown,
 * expired, replaced or already paid (the server answers all four alike). The page never holds a
 * link token, only the code.
 */
export async function requestPosPaymentByCode(code: string): Promise<PaymentIntentInfo | null> {
  return post({ code }, true);
}

async function post(
  payload: Record<string, unknown>,
  endedIsNull = false,
): Promise<PaymentIntentInfo | null> {
  const res = await fetch(`${appConfig().supabaseUrl}/functions/v1/payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 409 || (res.status === 404 && endedIsNull)) return null;
  if (!res.ok) throw new Error('payment_unavailable');
  const body = (await res.json()) as Record<string, unknown>;
  if (body.none === true) return null;
  return {
    paymentId: String(body.payment_id),
    kind: body.kind as PaymentKind,
    amountMinor: Number(body.amount_minor),
    currency: String(body.currency),
    cancelCutoffHours: Number(body.cancel_cutoff_hours),
    releaseAfter: String(body.release_after),
    clientSecret: String(body.client_secret),
    publishableKey: String(body.publishable_key ?? ''),
  };
}
