import { describe, expect, it } from 'vitest';
import type { PaymentEvent } from '../payment.ts';
import { runPaymentContract, type PaymentHarness } from './contract.ts';
import { FakePaymentProvider } from './fake.ts';
import { hmacHex } from './signature.ts';
import { StripePaymentProvider } from './stripe.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');

runPaymentContract('fake', (): PaymentHarness => {
  const provider = new FakePaymentProvider('whsec', () => NOW);
  return {
    provider,
    webhook: (events, age = 0) => provider.signedWebhook(events, NOW - age * 1000),
    tamper: (req) => new Request(req.url, { method: 'POST', body: '[]', headers: req.headers }),
  };
});

/**
 * A Stripe stand-in that answers with the response shapes of the real API (test mode). Like Stripe,
 * it replays the first response for a repeated Idempotency-Key.
 */
function fakeStripeApi() {
  const intents = new Map<string, { id: string; amount: number; status: string }>();
  const replies = new Map<string, Response>();
  const calls: Array<{ url: string; body: string; headers: Headers }> = [];
  const err = (status: number, error: object) => Response.json({ error }, { status });
  const handle = (u: string, form: URLSearchParams): Response => {
    const path = u.replace('https://api.stripe.com/v1', '');
    const id = `pi_${intents.size + 1}`;
    if (path === '/customers') return Response.json({ id: 'cus_1' });
    if (path === '/setup_intents')
      return Response.json({ id: 'seti_1', client_secret: 'seti_1_secret' });
    if (path === '/refunds') {
      const amount = Number(form.get('amount') ?? intents.get(form.get('payment_intent')!)!.amount);
      return Response.json({ id: 're_1', amount });
    }
    if (path === '/payment_intents') {
      const off = form.get('off_session') === 'true';
      const manual = form.get('capture_method') === 'manual';
      const amount = Number(form.get('amount'));
      const status = off ? 'succeeded' : manual ? 'requires_capture' : 'succeeded';
      intents.set(id, { id, amount, status });
      return Response.json({ id, client_secret: `${id}_secret_x`, status, amount });
    }
    const [, pid, action] = /payment_intents\/([^/]+)\/(\w+)$/.exec(path)!;
    const intent = intents.get(pid!)!;
    if (action === 'cancel') {
      if (intent.status === 'canceled')
        return err(400, {
          code: 'payment_intent_unexpected_state',
          payment_intent: { status: 'canceled' },
        });
      intent.status = 'canceled';
    } else if (action === 'capture') {
      const amount = Number(form.get('amount_to_capture') ?? intent.amount);
      if (amount > intent.amount) return err(400, { code: 'amount_too_large' });
      intent.status = 'succeeded';
      return Response.json({ ...intent, amount_received: amount });
    }
    return Response.json(intent);
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    calls.push({ url: String(url), body, headers });
    expect(headers.get('authorization')).toBe('Bearer sk_test_123');
    const key = headers.get('idempotency-key');
    const cacheKey = key ? `${url}|${key}` : undefined;
    if (cacheKey && replies.has(cacheKey)) return replies.get(cacheKey)!.clone();
    const res = handle(String(url), new URLSearchParams(body));
    if (cacheKey) replies.set(cacheKey, res.clone());
    return res;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, intents };
}

const STRIPE_TYPE: Record<PaymentEvent['type'], string> = {
  hold_succeeded: 'payment_intent.amount_capturable_updated',
  hold_failed: 'payment_intent.payment_failed',
  captured: 'payment_intent.succeeded',
  released: 'payment_intent.canceled',
};

const stripeProvider = (api = fakeStripeApi(), opts = {}) =>
  new StripePaymentProvider({
    secretKey: 'sk_test_123',
    webhookSecret: 'whsec_x',
    fetch: api.fetch,
    now: () => NOW,
    ...opts,
  });

async function stripeWebhook(event: unknown, ageSeconds = 0, secret = 'whsec_x') {
  const body = JSON.stringify(event);
  const t = Math.floor(NOW / 1000) - ageSeconds;
  const v1 = await hmacHex(secret, `${t}.${body}`);
  return new Request('https://x.test/hook', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${t},v1=${v1}` },
  });
}

runPaymentContract('stripe (recorded-shape HTTP fixtures)', (): PaymentHarness => ({
  provider: stripeProvider(),
  webhook: (events, age) => {
    const [e] = events as [PaymentEvent];
    return stripeWebhook(
      {
        id: e.eventId,
        type: STRIPE_TYPE[e.type],
        created: Math.floor(Date.parse(e.at) / 1000),
        data: { object: { id: e.holdId } },
      },
      age,
    );
  },
  tamper: (req) => {
    const headers = new Headers(req.headers);
    headers.set('stripe-signature', headers.get('stripe-signature')!.replace(/v1=./, 'v1=0'));
    return new Request(req.url, { method: 'POST', body: '{}', headers });
  },
}));

describe('StripePaymentProvider', () => {
  it('sends manual-capture PaymentIntents with the idempotency key and no card data', async () => {
    const api = fakeStripeApi();
    await stripeProvider(api).createHold({
      orgId: 'o',
      amountMinor: 2500,
      currency: 'USD',
      refId: 'v',
      idempotencyKey: 'k',
    });
    const [call] = api.calls;
    expect(call!.headers.get('idempotency-key')).toBe('k');
    const form = new URLSearchParams(call!.body);
    expect(form.get('capture_method')).toBe('manual');
    expect(form.get('currency')).toBe('usd');
    expect(form.get('metadata[org_id]')).toBe('o');
  });

  it('sends one Idempotency-Key per repeat and creates one intent', async () => {
    const api = fakeStripeApi();
    const input = {
      orgId: 'o',
      amountMinor: 900,
      currency: 'usd',
      refId: 'v',
      idempotencyKey: 'same',
    };
    const p = stripeProvider(api);
    const [a, b] = [await p.createDeposit(input), await p.createDeposit(input)];
    expect(a.intentId).toBe(b.intentId);
    expect(api.calls.map((c) => c.headers.get('idempotency-key'))).toEqual(['same', 'same']);
    expect(api.intents.size).toBe(1);
    expect(new URLSearchParams(api.calls[0]!.body).has('capture_method')).toBe(false);
  });

  it('saves cards for off-session use and charges them off-session', async () => {
    const api = fakeStripeApi();
    const p = stripeProvider(api);
    await p.saveCard({ orgId: 'o', refId: 'v', idempotencyKey: 'c' });
    expect(new URLSearchParams(api.calls[1]!.body).get('usage')).toBe('off_session');
    await p.chargeSavedCard({
      orgId: 'o',
      paymentMethodId: 'pm_1',
      customerId: 'cus_1',
      amountMinor: 500,
      currency: 'USD',
      idempotencyKey: 'f',
    });
    const form = new URLSearchParams(api.calls[2]!.body);
    expect([form.get('off_session'), form.get('confirm'), form.get('payment_method')]).toEqual([
      'true',
      'true',
      'pm_1',
    ]);
  });

  it('retries 5xx, 429 and network errors but not 4xx', async () => {
    const failing = (status: number | 'net') =>
      stripeProvider(undefined, {
        fetch: async () => {
          if (status === 'net') throw new TypeError('fetch failed');
          return Response.json({ error: { code: 'x' } }, { status });
        },
      }).release('pi_1', 'k');
    for (const [status, retryable] of [
      [503, true],
      [429, true],
      ['net', true],
      [402, false],
      [404, false],
    ] as const) {
      await expect(failing(status)).rejects.toMatchObject({ retryable });
    }
  });

  it('refuses an empty idempotency key and never retries a keyless call', async () => {
    const down = stripeProvider(undefined, {
      fetch: async () => new Response('{}', { status: 503 }),
    });
    await expect(down.refund('pi_1', undefined, '')).rejects.toMatchObject({ retryable: false });
    await expect(down.release('pi_1')).rejects.toMatchObject({ retryable: false });
  });

  it('maps events and ignores ones it does not act on', async () => {
    const p = stripeProvider();
    const ev = (type: string, object: object) => ({
      id: 'evt_9',
      type,
      created: 1,
      data: { object },
    });
    expect(
      await p.parseWebhook(
        await stripeWebhook(ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 700 })),
      ),
    ).toMatchObject([{ type: 'captured', amountMinor: 700, eventId: 'evt_9' }]);
    expect(
      await p.parseWebhook(
        await stripeWebhook(
          ev('payment_intent.payment_failed', {
            id: 'pi_1',
            last_payment_error: { code: 'card_declined' },
          }),
        ),
      ),
    ).toMatchObject([{ type: 'hold_failed', code: 'card_declined' }]);
    expect(
      await p.parseWebhook(await stripeWebhook(ev('customer.created', { id: 'cus_1' }))),
    ).toEqual([]);
  });

  it('rejects a signature made with another secret', async () => {
    await expect(
      stripeProvider().parseWebhook(
        await stripeWebhook(
          { id: 'e', type: 'x', created: 1, data: { object: { id: 'p' } } },
          0,
          'other',
        ),
      ),
    ).rejects.toThrow('invalid_signature');
  });

  it('accepts any one of several v1 signatures', async () => {
    const req = await stripeWebhook({
      id: 'e',
      type: 'payment_intent.canceled',
      created: 1,
      data: { object: { id: 'p' } },
    });
    const headers = new Headers(req.headers);
    headers.set(
      'stripe-signature',
      headers.get('stripe-signature')!.replace('v1=', 'v1=deadbeef,v1='),
    );
    const rotated = new Request(req.url, {
      method: 'POST',
      body: await req.clone().text(),
      headers,
    });
    expect(await stripeProvider().parseWebhook(rotated)).toHaveLength(1);
  });

  it('refuses restricted live keys too', () => {
    expect(() => stripeProvider(undefined, { secretKey: 'rk_live_abc' })).toThrow(/PAYMENTS_LIVE/);
  });

  it('refuses a live key unless live is set', () => {
    expect(() => stripeProvider(undefined, { secretKey: 'sk_live_abc' })).toThrow(/PAYMENTS_LIVE/);
    expect(() => stripeProvider(undefined, { secretKey: 'sk_live_abc', live: true })).not.toThrow();
  });
});
