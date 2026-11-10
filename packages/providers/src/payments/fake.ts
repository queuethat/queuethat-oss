// In-memory PaymentProvider for tests and the local stack. Holds live in the instance; webhooks
// are signed with a shared secret so the contract suite exercises the same reject paths as Stripe.
import {
  PaymentError,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentResult,
} from '../payment.ts';
import { hmacHex, safeEqual } from './signature.ts';

export const FAKE_WEBHOOK_TOLERANCE_SECONDS = 300;

interface Intent {
  id: string;
  amountMinor: number;
  state: 'held' | 'captured' | 'released' | 'refunded';
  refundedMinor: number;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly providerName = 'fake';
  private intents = new Map<string, Intent>();
  private byKey = new Map<string, string>();

  constructor(
    private readonly webhookSecret = 'fake_whsec',
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createHold(input: Parameters<PaymentProvider['createHold']>[0]) {
    return this.open(input, 'held');
  }

  async createDeposit(input: Parameters<PaymentProvider['createDeposit']>[0]) {
    return this.open(input, 'captured');
  }

  async saveCard(input: Parameters<PaymentProvider['saveCard']>[0]) {
    const id = this.byKey.get(input.idempotencyKey) ?? `fake_seti_${crypto.randomUUID()}`;
    this.byKey.set(input.idempotencyKey, id);
    return { setupIntentId: id, clientSecret: `${id}_secret` };
  }

  async chargeSavedCard(input: Parameters<PaymentProvider['chargeSavedCard']>[0]) {
    const { intentId } = this.open(input, 'captured');
    return { intentId, status: 'succeeded', amountMinor: input.amountMinor } as PaymentResult;
  }

  async capture(
    intentId: string,
    amountMinor?: number,
    _idempotencyKey?: string,
  ): Promise<PaymentResult> {
    const intent = this.mustGet(intentId);
    if (intent.state === 'released') throw new PaymentError('intent_released', false);
    if (amountMinor !== undefined && amountMinor > intent.amountMinor)
      throw new PaymentError('amount_too_large', false);
    intent.state = 'captured';
    return { intentId, status: 'captured', amountMinor: amountMinor ?? intent.amountMinor };
  }

  async release(intentId: string, _idempotencyKey?: string): Promise<PaymentResult> {
    const intent = this.mustGet(intentId);
    if (intent.state === 'held') intent.state = 'released';
    return { intentId, status: 'released' };
  }

  async refund(intentId: string, amountMinor: number | undefined, idempotencyKey: string) {
    const intent = this.mustGet(intentId);
    const refund = this.byKey.get(idempotencyKey);
    if (intent.state !== 'captured' && !refund) throw new PaymentError('not_refundable', false);
    const amount = amountMinor ?? intent.amountMinor - intent.refundedMinor;
    if (!refund) {
      if (amount > intent.amountMinor - intent.refundedMinor)
        throw new PaymentError('amount_too_large', false);
      this.byKey.set(idempotencyKey, intentId);
      intent.refundedMinor += amount;
    }
    return { intentId, status: 'refunded', amountMinor: amount } as PaymentResult;
  }

  async parseWebhook(req: Request): Promise<PaymentEvent[]> {
    const body = await req.text();
    const [t, sig] = (req.headers.get('x-fake-signature') ?? '').split(':');
    const age = Math.abs(this.now() / 1000 - Number(t));
    if (!sig || !(age <= FAKE_WEBHOOK_TOLERANCE_SECONDS)) throw new Error('invalid_signature');
    if (!safeEqual(sig, await hmacHex(this.webhookSecret, `${t}.${body}`))) {
      throw new Error('invalid_signature');
    }
    const events = JSON.parse(body) as unknown;
    if (!Array.isArray(events) || events.length > 100) throw new Error('invalid_payload');
    return events as PaymentEvent[];
  }

  /** Builds a validly signed webhook request, as the provider would send. */
  async signedWebhook(events: PaymentEvent[], at = this.now()): Promise<Request> {
    const body = JSON.stringify(events);
    const t = Math.floor(at / 1000);
    const sig = await hmacHex(this.webhookSecret, `${t}.${body}`);
    return new Request('https://fake.test/webhook', {
      method: 'POST',
      headers: { 'x-fake-signature': `${t}:${sig}` },
      body,
    });
  }

  private open(input: { amountMinor: number; idempotencyKey: string }, state: Intent['state']) {
    const existing = this.byKey.get(input.idempotencyKey);
    const id = existing ?? `fake_pi_${crypto.randomUUID()}`;
    if (!existing) {
      this.byKey.set(input.idempotencyKey, id);
      this.intents.set(id, { id, amountMinor: input.amountMinor, state, refundedMinor: 0 });
    }
    return { intentId: id, clientSecret: `${id}_secret` };
  }

  private mustGet(intentId: string): Intent {
    const intent = this.intents.get(intentId);
    if (!intent) throw new PaymentError('unknown_intent', false);
    return intent;
  }
}
