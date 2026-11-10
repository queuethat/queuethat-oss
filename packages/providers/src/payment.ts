// Deposits, card holds and no-show fees (A-13). Implemented by StripePaymentProvider (test mode)
// and FakePaymentProvider. Amounts are integer minor units (cents). Card data never reaches us:
// clients confirm the returned `clientSecret` with the provider's hosted element (PCI SAQ A).

/** `eventId` is the provider's event id: the key that makes a replayed webhook a no-op. */
export type PaymentEvent = { eventId: string } & (
  | { type: 'hold_succeeded'; holdId: string; at: string }
  | { type: 'hold_failed'; holdId: string; code: string; at: string }
  | { type: 'captured'; holdId: string; amountMinor: number; at: string }
  | { type: 'released'; holdId: string; at: string }
);

export type PaymentStatus =
  'requires_action' | 'authorized' | 'succeeded' | 'captured' | 'released' | 'refunded' | 'failed';

export interface PaymentResult {
  intentId: string;
  status: PaymentStatus;
  /** Minor units actually moved by this call (captured or refunded); absent for a release. */
  amountMinor?: number;
}

/**
 * A provider call that failed. `retryable` is false for errors a retry cannot fix (declined card,
 * capture above the authorised amount, unknown intent), so the job runner dead-letters at once.
 */
export class PaymentError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
  }
}

interface MoneyInput {
  orgId: string;
  amountMinor: number;
  currency: string;
  /** Our visit or appointment id, echoed into provider metadata for reconciliation. */
  refId: string;
  idempotencyKey: string;
}

export interface PaymentProvider {
  readonly providerName: string;
  /** Authorizes `amountMinor` without charging it. The same idempotencyKey returns the same hold. */
  createHold(i: MoneyInput): Promise<{ intentId: string; clientSecret: string }>;
  /** Charges `amountMinor` at once (automatic capture). */
  createDeposit(i: MoneyInput): Promise<{ intentId: string; clientSecret: string }>;
  /** Saves a card for later off-session use (SetupIntent), for appointments too far out to hold. */
  saveCard(i: {
    orgId: string;
    refId: string;
    idempotencyKey: string;
  }): Promise<{ setupIntentId: string; clientSecret: string }>;
  /** Charges a saved card off-session (no-show fee). A card that needs the guest present fails non-retryably. */
  chargeSavedCard(i: {
    orgId: string;
    paymentMethodId: string;
    customerId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<PaymentResult>;
  /** Charges a hold, or part of it. Above the authorised amount throws a non-retryable PaymentError. */
  capture(intentId: string, amountMinor?: number, idempotencyKey?: string): Promise<PaymentResult>;
  /** Drops a hold without charging. Releasing twice is a no-op. */
  release(intentId: string, idempotencyKey?: string): Promise<PaymentResult>;
  /** Refunds all (`undefined`) or part of a succeeded payment. */
  refund(
    intentId: string,
    amountMinor: number | undefined,
    idempotencyKey: string,
  ): Promise<PaymentResult>;
  /** Verifies the provider's signature and returns the events in a webhook request. Throws on a bad or stale signature. */
  parseWebhook(req: Request): Promise<PaymentEvent[]>;
}
