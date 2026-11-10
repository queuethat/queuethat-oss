// Subscription billing on the platform's own Stripe account (hosted SaaS only; self-host never
// constructs one). Implemented by StripeBillingProvider (test mode) and FakeBillingProvider.
// Amounts live in Stripe's Prices; this interface only moves quantities and sessions.

/** A subscription change the billing function forwards to `api.apply_billing_event`. */
export type BillingEvent = {
  /** Stripe's event id, for logs. Replays are harmless: the database applies events in order. */
  eventId: string;
  /** ISO time Stripe created the event: the order events are applied in. */
  at: string;
} & (
  | {
      type: 'subscription' | 'deleted';
      /** The org id we put in the subscription's metadata when we created it; null if absent. */
      orgId: string | null;
      customerId: string;
      subscriptionId: string;
      status: string;
      priceId: string | null;
      quantity: number | null;
      periodEnd: string | null;
    }
  | { type: 'payment_failed'; customerId: string | null; subscriptionId: string }
  | {
      /**
       * A paid invoice that carries the monthly SMS bundle. `invoiceId` makes the credit idempotent; the
       * amount is the database's setting, never the event's.
       */
      type: 'bundle_paid';
      invoiceId: string;
      subscriptionId: string;
    }
  | {
      /** A paid prepaid-credit Checkout (SMS credit). `sessionId` makes the credit idempotent. */
      type: 'topup';
      orgId: string | null;
      sessionId: string;
      amountMinor: number;
      currency: string;
    }
);

export interface BillingProvider {
  readonly providerName: string;
  /**
   * Sets the subscription's per-location quantity. The same idempotencyKey is the same call, so a
   * retried job never bills twice. Failures are PaymentError (`retryable` says whether to retry).
   */
  setQuantity(
    subscriptionId: string,
    quantity: number,
    idempotencyKey: string,
  ): Promise<{ quantity: number }>;
  /** A short-lived Customer Portal link for cards, invoices and cancellation. */
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  /**
   * A hosted Checkout page that starts the org's subscription at `quantity` locations. The org id goes
   * into the subscription's metadata, where `parseWebhook` reads it back.
   */
  createCheckoutSession(i: {
    orgId: string;
    /** The org's existing Stripe customer, if it ever had one. */
    customerId: string | null;
    priceId: string;
    quantity: number;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
  /** A hosted Checkout page for a one-off SMS credit top-up of `amountMinor` (USD). No auto-refill. */
  createTopUpSession(i: {
    orgId: string;
    amountMinor: number;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
  /** Verifies the provider's signature and returns the events in a webhook request. Throws on a bad or stale signature. */
  parseWebhook(req: Request): Promise<BillingEvent[]>;
}
