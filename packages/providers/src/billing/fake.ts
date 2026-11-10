// In-memory BillingProvider for tests and the local stack. Webhooks are signed with a shared secret
// so the same reject paths run as with Stripe.
import { PaymentError } from '../payment.ts';
import type { BillingEvent, BillingProvider } from '../billing.ts';
import { hmacHex, safeEqual } from '../payments/signature.ts';

export const FAKE_BILLING_TOLERANCE_SECONDS = 300;

export class FakeBillingProvider implements BillingProvider {
  readonly providerName = 'fake';
  /** subscription id -> quantity, as Stripe would hold it. */
  readonly quantities = new Map<string, number>();
  private readonly byKey = new Map<string, number>();

  constructor(
    private readonly webhookSecret = 'fake_whsec',
    private readonly now: () => number = () => Date.now(),
  ) {}

  async setQuantity(subscriptionId: string, quantity: number, idempotencyKey: string) {
    if (!idempotencyKey) throw new PaymentError('invalid_idempotency_key', false);
    if (!Number.isInteger(quantity) || quantity < 0)
      throw new PaymentError('invalid_quantity', false);
    const done = this.byKey.get(idempotencyKey);
    if (done !== undefined) return { quantity: done };
    this.byKey.set(idempotencyKey, quantity);
    this.quantities.set(subscriptionId, quantity);
    return { quantity };
  }

  async createPortalSession(customerId: string, returnUrl: string) {
    return {
      url: `https://billing.fake.test/portal/${encodeURIComponent(customerId)}?return=${encodeURIComponent(returnUrl)}`,
    };
  }

  async createCheckoutSession(i: Parameters<BillingProvider['createCheckoutSession']>[0]) {
    if (!i.idempotencyKey || i.quantity < 1) throw new PaymentError('invalid_input', false);
    return { url: `https://billing.fake.test/checkout/${i.orgId}?quantity=${i.quantity}` };
  }

  async createTopUpSession(i: Parameters<BillingProvider['createTopUpSession']>[0]) {
    if (!i.idempotencyKey || i.amountMinor < 100) throw new PaymentError('invalid_input', false);
    return { url: `https://billing.fake.test/topup/${i.orgId}?amount=${i.amountMinor}` };
  }

  async parseWebhook(req: Request): Promise<BillingEvent[]> {
    const body = await req.text();
    const [t, sig] = (req.headers.get('x-fake-signature') ?? '').split(':');
    const age = Math.abs(this.now() / 1000 - Number(t));
    if (!sig || !(age <= FAKE_BILLING_TOLERANCE_SECONDS)) throw new Error('invalid_signature');
    if (!safeEqual(sig, await hmacHex(this.webhookSecret, `${t}.${body}`)))
      throw new Error('invalid_signature');
    const events = JSON.parse(body) as unknown;
    if (!Array.isArray(events) || events.length > 100) throw new Error('invalid_payload');
    return events as BillingEvent[];
  }

  /** Builds a validly signed webhook request, as the provider would send. */
  async signedWebhook(events: BillingEvent[], at = this.now()): Promise<Request> {
    const body = JSON.stringify(events);
    const t = Math.floor(at / 1000);
    return new Request('https://fake.test/webhook', {
      method: 'POST',
      headers: { 'x-fake-signature': `${t}:${await hmacHex(this.webhookSecret, `${t}.${body}`)}` },
      body,
    });
  }
}
