// Shared contract for PaymentProvider adapters. Import from '@qm/providers/payments/contract' in a
// *.test.ts file (needs Vitest).
import { describe, expect, it } from 'vitest';
import { PaymentError, type PaymentEvent, type PaymentProvider } from '../payment.ts';

export interface PaymentHarness {
  provider: PaymentProvider;
  /** A request the provider would send, validly signed, `ageSeconds` old. */
  webhook(events: PaymentEvent[], ageSeconds?: number): Promise<Request>;
  /** The same request with a tampered signature. */
  tamper(req: Request): Request;
}

const hold = (idempotencyKey: string) => ({
  orgId: crypto.randomUUID(),
  amountMinor: 2500,
  currency: 'usd',
  refId: crypto.randomUUID(),
  idempotencyKey,
});

export function runPaymentContract(
  name: string,
  factory: () => PaymentHarness | Promise<PaymentHarness>,
) {
  describe(`PaymentProvider contract: ${name}`, () => {
    it('repeats createHold for one idempotency key and splits on another', async () => {
      const { provider } = await factory();
      const a = await provider.createHold(hold('k1'));
      const again = await provider.createHold(hold('k1'));
      const other = await provider.createHold(hold('k2'));
      expect(again.intentId).toBe(a.intentId);
      expect(other.intentId).not.toBe(a.intentId);
      expect(a.clientSecret).toBeTruthy();
    });

    it('captures a hold and releases without error, twice over', async () => {
      const { provider } = await factory();
      const a = await provider.createHold(hold('cap'));
      await expect(provider.capture(a.intentId, 1000, 'cap-1')).resolves.toMatchObject({
        intentId: a.intentId,
        status: 'captured',
      });
      const b = await provider.createHold(hold('rel'));
      await provider.release(b.intentId, 'rel-1');
      await expect(provider.release(b.intentId, 'rel-1')).resolves.toMatchObject({
        status: 'released',
      });
    });

    it('refuses to capture more than was authorised, and not as a retryable error', async () => {
      const { provider } = await factory();
      const a = await provider.createHold(hold('over'));
      const err = await provider.capture(a.intentId, 2501, 'over-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).retryable).toBe(false);
    });

    it('takes a deposit, saves a card and charges it off-session', async () => {
      const { provider } = await factory();
      const dep = await provider.createDeposit(hold('dep'));
      expect(dep.clientSecret).toBeTruthy();
      const card = await provider.saveCard({ orgId: 'o', refId: 'r', idempotencyKey: 'card' });
      expect(card.setupIntentId).toBeTruthy();
      const fee = await provider.chargeSavedCard({
        orgId: 'o',
        paymentMethodId: 'pm_1',
        customerId: 'cus_1',
        amountMinor: 500,
        currency: 'usd',
        idempotencyKey: 'fee',
      });
      expect(fee.status).toBe('succeeded');
    });

    it('refunds a captured payment once per idempotency key, in full or in part', async () => {
      const { provider } = await factory();
      const dep = await provider.createDeposit(hold('refund'));
      const first = await provider.refund(dep.intentId, 1000, 'ref-1');
      const again = await provider.refund(dep.intentId, 1000, 'ref-1');
      expect(first).toMatchObject({ status: 'refunded', amountMinor: 1000 });
      expect(again).toEqual(first);
    });

    it('returns the events of a validly signed webhook', async () => {
      const h = await factory();
      const events: PaymentEvent[] = [
        { eventId: 'evt_1', type: 'released', holdId: 'h1', at: '2026-10-30T12:00:00.000Z' },
      ];
      expect(await h.provider.parseWebhook(await h.webhook(events))).toMatchObject([
        { eventId: 'evt_1', type: 'released', holdId: 'h1' },
      ]);
    });

    it('rejects a bad signature and a stale timestamp', async () => {
      const h = await factory();
      const events: PaymentEvent[] = [
        { eventId: 'evt_2', type: 'released', holdId: 'h1', at: '2026-10-30T12:00:00.000Z' },
      ];
      await expect(h.provider.parseWebhook(h.tamper(await h.webhook(events)))).rejects.toThrow();
      await expect(h.provider.parseWebhook(await h.webhook(events, 301))).rejects.toThrow();
    });
  });
}
