// Stripe adapter over the REST API with fetch (no Node SDK, so Deno and browsers work). Card data
// never reaches us: the client confirms the PaymentIntent with `clientSecret` via Payment Element.
import {
  PaymentError,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentResult,
  type PaymentStatus,
} from '../payment.ts';
import { STRIPE_WEBHOOK_TOLERANCE_SECONDS, verifyStripeSignature } from './signature.ts';

export { STRIPE_WEBHOOK_TOLERANCE_SECONDS };
const API = 'https://api.stripe.com/v1';

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  /** Permit `sk_live_` keys. Only phase 3 (PAYMENTS_LIVE=true) sets this. */
  live?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

interface StripeIntent {
  id: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  last_payment_error?: { code?: string } | null;
}

export class StripePaymentProvider implements PaymentProvider {
  readonly providerName = 'stripe';
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: StripeOptions) {
    // An allowlist, so restricted (rk_live_) and any future key shape are refused too.
    if (!opts.live && !/^(sk|rk)_test_/.test(opts.secretKey.trim())) {
      throw new Error('Refusing a non-test Stripe key: set PAYMENTS_LIVE=true (phase 3 only)');
    }
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  createHold(input: MoneyInput) {
    return this.intent(input, { capture_method: 'manual' });
  }

  createDeposit(input: MoneyInput) {
    return this.intent(input, {});
  }

  async saveCard(input: { orgId: string; refId: string; idempotencyKey: string }) {
    const meta = { 'metadata[org_id]': input.orgId, 'metadata[ref_id]': input.refId };
    const customer = await this.post<{ id: string }>(
      '/customers',
      meta,
      `${input.idempotencyKey}:customer`,
    );
    const setup = await this.post<{ id: string; client_secret: string }>(
      '/setup_intents',
      {
        customer: customer.id,
        usage: 'off_session',
        'automatic_payment_methods[enabled]': 'true',
        ...meta,
      },
      input.idempotencyKey,
    );
    return { setupIntentId: setup.id, clientSecret: setup.client_secret };
  }

  async chargeSavedCard(input: {
    orgId: string;
    paymentMethodId: string;
    customerId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }) {
    const intent = await this.post<StripeIntent>(
      '/payment_intents',
      {
        amount: String(input.amountMinor),
        currency: input.currency.toLowerCase(),
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        off_session: 'true',
        confirm: 'true',
        'metadata[org_id]': input.orgId,
      },
      input.idempotencyKey,
    );
    return result(intent);
  }

  async capture(intentId: string, amountMinor?: number, idempotencyKey?: string) {
    const intent = await this.post<StripeIntent>(
      `/payment_intents/${encodeURIComponent(intentId)}/capture`,
      amountMinor === undefined ? {} : { amount_to_capture: String(amountMinor) },
      idempotencyKey,
    );
    return result(intent, 'captured');
  }

  async release(intentId: string, idempotencyKey?: string): Promise<PaymentResult> {
    try {
      await this.post(
        `/payment_intents/${encodeURIComponent(intentId)}/cancel`,
        {},
        idempotencyKey,
      );
    } catch (err) {
      // Cancelling a cancelled intent is Stripe's `payment_intent_unexpected_state`: a no-op for us.
      if (!(err instanceof StripeError && err.status === 400 && err.intentStatus === 'canceled'))
        throw err;
    }
    return { intentId, status: 'released' };
  }

  async refund(intentId: string, amountMinor: number | undefined, idempotencyKey: string) {
    const refund = await this.post<{ amount: number }>(
      '/refunds',
      {
        payment_intent: intentId,
        ...(amountMinor === undefined ? {} : { amount: String(amountMinor) }),
      },
      idempotencyKey,
    );
    return { intentId, status: 'refunded', amountMinor: refund.amount } as PaymentResult;
  }

  async parseWebhook(req: Request): Promise<PaymentEvent[]> {
    const body = await req.text();
    await verifyStripeSignature(
      body,
      req.headers.get('stripe-signature') ?? '',
      this.opts.webhookSecret,
      this.now(),
    );
    const event = JSON.parse(body) as {
      id: string;
      type: string;
      created: number;
      data: { object: StripeIntent };
    };
    const at = new Date(event.created * 1000).toISOString();
    const holdId = event.data.object.id;
    const base = { eventId: event.id, holdId, at };
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated':
        return [{ ...base, type: 'hold_succeeded' }];
      case 'payment_intent.payment_failed':
        return [
          {
            ...base,
            type: 'hold_failed',
            code: event.data.object.last_payment_error?.code ?? 'unknown',
          },
        ];
      case 'payment_intent.succeeded':
        return [{ ...base, type: 'captured', amountMinor: event.data.object.amount_received ?? 0 }];
      case 'payment_intent.canceled':
        return [{ ...base, type: 'released' }];
      default:
        return []; // Events we don't act on are acknowledged, not errors.
    }
  }

  private async intent(input: MoneyInput, extra: Record<string, string>) {
    const intent = await this.post<{ id: string; client_secret: string }>(
      '/payment_intents',
      {
        amount: String(input.amountMinor),
        currency: input.currency.toLowerCase(),
        'automatic_payment_methods[enabled]': 'true',
        'metadata[org_id]': input.orgId,
        'metadata[ref_id]': input.refId,
        ...extra,
      },
      input.idempotencyKey,
    );
    return { intentId: intent.id, clientSecret: intent.client_secret };
  }

  private post<T>(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<T> {
    return stripeRequest<T>(
      { secretKey: this.opts.secretKey, fetch: this.doFetch },
      'POST',
      path,
      form,
      idempotencyKey,
    );
  }
}

/**
 * One Stripe REST call. A POST with an idempotency key is retryable on 5xx, 429 and 409; one without
 * is never retried, because a retry could repeat the effect.
 */
export async function stripeRequest<T>(
  o: { secretKey: string; fetch?: typeof fetch },
  method: 'GET' | 'POST',
  path: string,
  form: Record<string, string> = {},
  idempotencyKey?: string,
): Promise<T> {
  if (idempotencyKey === '') throw new PaymentError('invalid_idempotency_key', false);
  const retryable = method === 'GET' || idempotencyKey !== undefined;
  const res = await (o.fetch ?? fetch)(`${API}${path}`, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${o.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(method === 'POST' ? { body: new URLSearchParams(form) } : {}),
  }).catch((cause) => {
    void cause; // never echoed: it can carry the request URL
    throw new PaymentError('network', retryable);
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; payment_intent?: { status?: string } };
  };
  if (!res.ok)
    throw new StripeError(
      retryable,
      res.status,
      json.error?.code ?? 'unknown',
      json.error?.payment_intent?.status,
    );
  return json as T;
}

/** 5xx, rate limits and idempotency-key collisions in flight are worth retrying; 4xx is not. */
class StripeError extends PaymentError {
  constructor(
    mayRetry: boolean,
    readonly status: number,
    code: string,
    readonly intentStatus?: string,
  ) {
    // Only code and status: Stripe's message can carry customer or payment ids.
    super(
      code,
      mayRetry && (status >= 500 || status === 429 || status === 409),
      `stripe ${status} ${code}`,
    );
  }
}

interface MoneyInput {
  orgId: string;
  amountMinor: number;
  currency: string;
  refId: string;
  idempotencyKey: string;
}

function result(intent: StripeIntent, succeeded: PaymentStatus = 'succeeded'): PaymentResult {
  const status: PaymentStatus =
    intent.status === 'succeeded'
      ? succeeded
      : intent.status === 'requires_capture'
        ? 'authorized'
        : intent.status === 'canceled'
          ? 'released'
          : intent.status === 'requires_action'
            ? 'requires_action'
            : 'failed';
  return { intentId: intent.id, status, amountMinor: intent.amount_received ?? intent.amount };
}
