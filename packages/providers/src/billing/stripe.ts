// Stripe Billing over the REST API with fetch. Test mode only until hosted billing goes live.
import { PaymentError } from '../payment.ts';
import type { BillingEvent, BillingProvider } from '../billing.ts';
import { verifyStripeSignature } from '../payments/signature.ts';
import { stripeRequest } from '../payments/stripe.ts';

export interface StripeBillingOptions {
  secretKey: string;
  webhookSecret: string;
  /** Permit `sk_live_` keys. Only the hosted launch (BILLING_LIVE=true) sets this. */
  live?: boolean;
  /**
   * Stripe Price ids (monthly and annual) of the per-location item. When set, `setQuantity` updates
   * the one item carrying one of them, so another item (the SMS bundle) can share the subscription.
   * When empty, a subscription must have exactly one item, which is the location item.
   */
  locationPriceIds?: readonly string[];
  /**
   * Stripe Price id of the monthly SMS bundle. An `invoice.paid` with a charged line for it grants credit;
   * subscription events ignore its item, so it never changes the seat count or plan.
   */
  bundlePriceId?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  metadata?: Record<string, string>;
  current_period_end?: number;
  items: {
    data: Array<{
      id: string;
      quantity?: number;
      current_period_end?: number;
      price?: { id?: string };
    }>;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (seconds: number | undefined) =>
  seconds ? new Date(seconds * 1000).toISOString() : null;

/** The subscription an invoice belongs to: `subscription` before API version 2025-03-31, `parent.subscription_details` after. */
function invoiceSubscription(obj: Record<string, unknown>): string | undefined {
  const parent = (obj.parent as { subscription_details?: { subscription?: string } } | undefined)
    ?.subscription_details?.subscription;
  return typeof obj.subscription === 'string' ? obj.subscription : parent;
}

interface InvoiceLine {
  price?: { id?: string };
  pricing?: { price_details?: { price?: string } };
}

/** Price ids on an invoice's lines: `line.price.id` before API version 2025-03-31, `line.pricing.price_details.price` after. */
function invoiceLinePrices(obj: Record<string, unknown>): string[] {
  const lines = (obj.lines as { data?: InvoiceLine[] } | undefined)?.data ?? [];
  return lines
    .map((l) => l.pricing?.price_details?.price ?? l.price?.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Stripe Tax on every Checkout. A tax address is required to compute GST/PST, and tax ids let
 * businesses enter theirs. Subscription Prices must have tax_behavior=exclusive in the Dashboard
 * (Checkout cannot set it on an existing Price).
 */
const TAX_PARAMS = {
  'automatic_tax[enabled]': 'true',
  billing_address_collection: 'required',
  'tax_id_collection[enabled]': 'true',
} as const;

export class StripeBillingProvider implements BillingProvider {
  readonly providerName = 'stripe';
  private readonly now: () => number;

  constructor(private readonly opts: StripeBillingOptions) {
    if (!opts.live && !/^(sk|rk)_test_/.test(opts.secretKey.trim())) {
      throw new Error('Refusing a non-test Stripe key: set BILLING_LIVE=true (hosted launch only)');
    }
    this.now = opts.now ?? (() => Date.now());
  }

  async setQuantity(subscriptionId: string, quantity: number, idempotencyKey: string) {
    const sub = await this.call<StripeSubscription>(
      'GET',
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    const item = this.locationItem(sub);
    const updated = await this.call<{ quantity: number }>(
      'POST',
      `/subscription_items/${encodeURIComponent(item.id)}`,
      { quantity: String(quantity), proration_behavior: 'create_prorations' },
      idempotencyKey,
    );
    return { quantity: updated.quantity };
  }

  /** The subscription's per-location item. Never guesses between items: an error is final, not retried. */
  private locationItem(sub: StripeSubscription) {
    const ids = this.opts.locationPriceIds;
    const items = sub.items.data;
    if (!ids?.length) {
      if (items.length !== 1 || !items[0]) throw new PaymentError('unexpected_subscription', false);
      return items[0];
    }
    const matches = items.filter((i) => i.price?.id && ids.includes(i.price.id));
    if (matches.length > 1) throw new PaymentError('location_item_ambiguous', false);
    if (!matches[0]) throw new PaymentError('location_item_not_found', false);
    return matches[0];
  }

  /**
   * The item whose price and quantity describe the plan in subscription events. With location prices
   * configured it is the item carrying one; otherwise the first item that is not the SMS bundle.
   */
  private subscriptionItem(sub: StripeSubscription) {
    const items = sub.items?.data ?? [];
    const ids = this.opts.locationPriceIds;
    if (ids?.length) return items.find((i) => i.price?.id && ids.includes(i.price.id));
    return items.find((i) => !this.opts.bundlePriceId || i.price?.id !== this.opts.bundlePriceId);
  }

  async createPortalSession(customerId: string, returnUrl: string) {
    const session = await this.call<{ url: string }>(
      'POST',
      '/billing_portal/sessions',
      { customer: customerId, return_url: returnUrl },
      crypto.randomUUID(),
    );
    return { url: session.url };
  }

  async createCheckoutSession(i: Parameters<BillingProvider['createCheckoutSession']>[0]) {
    const session = await this.call<{ url: string }>(
      'POST',
      '/checkout/sessions',
      {
        mode: 'subscription',
        'line_items[0][price]': i.priceId,
        'line_items[0][quantity]': String(i.quantity),
        'subscription_data[metadata][org_id]': i.orgId,
        client_reference_id: i.orgId,
        success_url: i.returnUrl,
        cancel_url: i.returnUrl,
        ...TAX_PARAMS,
        // Stripe requires these to let Checkout save the address and tax id it collects onto an existing customer.
        ...(i.customerId
          ? {
              customer: i.customerId,
              'customer_update[address]': 'auto',
              'customer_update[name]': 'auto',
            }
          : {}),
      },
      i.idempotencyKey,
    );
    return { url: session.url };
  }

  async createTopUpSession(i: Parameters<BillingProvider['createTopUpSession']>[0]) {
    const session = await this.call<{ url: string }>(
      'POST',
      '/checkout/sessions',
      {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(i.amountMinor),
        'line_items[0][price_data][product_data][name]': 'SMS credit',
        // Tax is added on top of the credit; the tenant is credited the pre-tax amount (see parseWebhook).
        'line_items[0][price_data][tax_behavior]': 'exclusive',
        'line_items[0][quantity]': '1',
        'metadata[org_id]': i.orgId,
        'metadata[purpose]': 'sms_credit',
        client_reference_id: i.orgId,
        success_url: i.returnUrl,
        cancel_url: i.returnUrl,
        ...TAX_PARAMS,
      },
      i.idempotencyKey,
    );
    return { url: session.url };
  }

  async parseWebhook(req: Request): Promise<BillingEvent[]> {
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
      data: { object: Record<string, unknown> };
    };
    const base = { eventId: event.id, at: new Date(event.created * 1000).toISOString() };
    const obj = event.data.object;
    if (event.type === 'invoice.paid') {
      const bundle = this.opts.bundlePriceId;
      const subscriptionId = invoiceSubscription(obj);
      // Only a charged invoice with a bundle line grants: a $0 trial or fully discounted invoice does not.
      if (
        !bundle ||
        !subscriptionId ||
        typeof obj.id !== 'string' ||
        !(typeof obj.amount_paid === 'number' && obj.amount_paid > 0) ||
        !invoiceLinePrices(obj).includes(bundle)
      )
        return [];
      return [{ ...base, type: 'bundle_paid', invoiceId: obj.id, subscriptionId }];
    }
    if (event.type === 'invoice.payment_failed') {
      const subscriptionId = invoiceSubscription(obj);
      if (!subscriptionId) return [];
      return [
        {
          ...base,
          type: 'payment_failed',
          customerId: typeof obj.customer === 'string' ? obj.customer : null,
          subscriptionId,
        },
      ];
    }
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      // Subscription Checkouts share this event; only our own credit purchases that are paid count.
      if (
        meta.purpose !== 'sms_credit' ||
        obj.payment_status !== 'paid' ||
        typeof obj.id !== 'string'
      )
        return [];
      const org = meta.org_id;
      return [
        {
          ...base,
          type: 'topup',
          orgId:
            org === undefined
              ? null
              : UUID.test(org)
                ? org
                : '00000000-0000-0000-0000-000000000000',
          sessionId: obj.id,
          // Pre-tax: `amount_total` includes GST/PST, which is not credit the tenant bought.
          amountMinor: Number.isInteger(obj.amount_subtotal)
            ? (obj.amount_subtotal as number)
            : Number.isInteger(obj.amount_total)
              ? (obj.amount_total as number)
              : 0,
          currency: typeof obj.currency === 'string' ? obj.currency : '',
        },
      ];
    }
    const type = {
      'customer.subscription.created': 'subscription',
      'customer.subscription.updated': 'subscription',
      'customer.subscription.deleted': 'deleted',
    }[event.type] as 'subscription' | 'deleted' | undefined;
    if (!type) return []; // Events we don't act on are acknowledged, not errors.
    const sub = obj as unknown as StripeSubscription;
    const item = this.subscriptionItem(sub);
    const metaOrg = sub.metadata?.org_id;
    return [
      {
        ...base,
        type,
        // A metadata org that isn't a uuid can't match anything: the nil uuid never does.
        orgId:
          metaOrg === undefined
            ? null
            : UUID.test(metaOrg)
              ? metaOrg
              : '00000000-0000-0000-0000-000000000000',
        customerId: sub.customer,
        subscriptionId: sub.id,
        status: sub.status,
        priceId: item?.price?.id ?? null,
        quantity: item?.quantity ?? null,
        periodEnd: iso(item?.current_period_end ?? sub.current_period_end),
      },
    ];
  }

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
    key?: string,
  ) {
    return stripeRequest<T>(
      { secretKey: this.opts.secretKey, fetch: this.opts.fetch },
      method,
      path,
      form,
      key,
    );
  }
}
