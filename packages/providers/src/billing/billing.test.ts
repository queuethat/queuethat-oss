import { describe, expect, it } from 'vitest';
import type { BillingEvent } from '../billing.ts';
import { PaymentError } from '../payment.ts';
import { hmacHex } from '../payments/signature.ts';
import { FakeBillingProvider } from './fake.ts';
import { StripeBillingProvider } from './stripe.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const ORG = '6f1d2c3e-1111-4222-8333-444455556666';

function stripeApi(
  items: Array<{ id: string; quantity?: number; price?: { id: string } }> = [
    { id: 'si_1', quantity: 1 },
  ],
) {
  const calls: Array<{ method: string; path: string; body: string; key: string | null }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method!,
      path: url.replace('https://api.stripe.com/v1', ''),
      body: String(init.body ?? ''),
      key: headers.get('idempotency-key'),
    });
    if (url.endsWith('/subscriptions/sub_1'))
      return Response.json({ id: 'sub_1', items: { data: items } });
    if (url.endsWith('/subscription_items/si_1')) return Response.json({ quantity: 3 });
    if (url.endsWith('/subscription_items/si_loc')) return Response.json({ quantity: 3 });
    if (url.endsWith('/checkout/sessions'))
      return Response.json({ url: 'https://checkout.stripe.com/c/x' });
    if (url.endsWith('/billing_portal/sessions'))
      return Response.json({ url: 'https://billing.stripe.com/s/x' });
    return Response.json({ error: { code: 'resource_missing' } }, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

async function stripeWebhook(secret: string, type: string, object: object, ageSeconds = 0) {
  const body = JSON.stringify({ id: 'evt_1', type, created: NOW / 1000 - 5, data: { object } });
  const t = Math.floor(NOW / 1000) - ageSeconds;
  const sig = await hmacHex(secret, `${t}.${body}`);
  return new Request('https://x.test/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${t},v1=${sig}` },
  });
}

describe('StripeBillingProvider', () => {
  const make = (fetcher?: typeof fetch) =>
    new StripeBillingProvider({
      secretKey: 'sk_test_1',
      webhookSecret: 'whsec',
      fetch: fetcher,
      now: () => NOW,
    });

  it('refuses a live key unless asked', () => {
    expect(
      () => new StripeBillingProvider({ secretKey: 'sk_live_1', webhookSecret: 'w' }),
    ).toThrow();
    expect(
      () => new StripeBillingProvider({ secretKey: 'sk_live_1', webhookSecret: 'w', live: true }),
    ).not.toThrow();
  });

  it('sets the quantity on the one subscription item with the job id as idempotency key', async () => {
    const { calls, fetcher } = stripeApi();
    await expect(make(fetcher).setQuantity('sub_1', 3, 'job-1')).resolves.toEqual({ quantity: 3 });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/subscriptions/sub_1' });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      path: '/subscription_items/si_1',
      key: 'job-1',
    });
    expect(calls[1]?.body).toContain('quantity=3');
  });

  describe('with a bundle item beside the location item', () => {
    const items = [
      { id: 'si_bundle', quantity: 1, price: { id: 'price_bundle' } },
      { id: 'si_loc', quantity: 1, price: { id: 'price_loc_month' } },
    ];
    const withPrices = (
      fetcher: typeof fetch,
      ids: string[] = ['price_loc_month', 'price_loc_year'],
    ) =>
      new StripeBillingProvider({
        secretKey: 'sk_test_1',
        webhookSecret: 'whsec',
        fetch: fetcher,
        now: () => NOW,
        locationPriceIds: ids,
      });

    it('updates only the location item, found by price id', async () => {
      const { calls, fetcher } = stripeApi(items);
      await expect(withPrices(fetcher).setQuantity('sub_1', 3, 'job-1')).resolves.toEqual({
        quantity: 3,
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ method: 'POST', path: '/subscription_items/si_loc' });
    });

    it('accepts the annual price as the location item too', async () => {
      const { calls, fetcher } = stripeApi([
        items[0]!,
        { id: 'si_loc', quantity: 1, price: { id: 'price_loc_year' } },
      ]);
      await withPrices(fetcher).setQuantity('sub_1', 3, 'k');
      expect(calls[1]?.path).toBe('/subscription_items/si_loc');
    });

    it('fails clearly and without retry when no item has a location price', async () => {
      const { calls, fetcher } = stripeApi(items);
      await expect(
        withPrices(fetcher, ['price_other']).setQuantity('sub_1', 3, 'k'),
      ).rejects.toMatchObject({
        code: 'location_item_not_found',
        retryable: false,
      });
      expect(calls).toHaveLength(1);
    });

    it('fails clearly when two items carry a location price', async () => {
      const { fetcher } = stripeApi([
        { id: 'si_a', price: { id: 'price_loc_month' } },
        { id: 'si_b', price: { id: 'price_loc_year' } },
      ]);
      await expect(withPrices(fetcher).setQuantity('sub_1', 3, 'k')).rejects.toMatchObject({
        code: 'location_item_ambiguous',
        retryable: false,
      });
    });

    it('without configured price ids a multi-item subscription still fails', async () => {
      const { fetcher } = stripeApi(items);
      await expect(make(fetcher).setQuantity('sub_1', 3, 'k')).rejects.toMatchObject({
        code: 'unexpected_subscription',
        retryable: false,
      });
    });
  });

  it('classifies failures: an unknown subscription is final, a 5xx is retryable', async () => {
    const { fetcher } = stripeApi();
    await expect(make(fetcher).setQuantity('sub_x', 1, 'k')).rejects.toMatchObject({
      retryable: false,
      code: 'resource_missing',
    });
    const down = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(make(down).setQuantity('sub_1', 1, 'k')).rejects.toMatchObject({
      retryable: true,
    });
    await expect(make(down).setQuantity('sub_1', 1, 'k')).rejects.toBeInstanceOf(PaymentError);
  });

  it('opens a portal session for the customer', async () => {
    const { calls, fetcher } = stripeApi();
    await expect(
      make(fetcher).createPortalSession('cus_1', 'https://app.test/admin/billing'),
    ).resolves.toEqual({
      url: 'https://billing.stripe.com/s/x',
    });
    expect(calls[0]?.body).toContain('customer=cus_1');
  });

  it('starts a subscription Checkout with the org id in the subscription metadata', async () => {
    const { calls, fetcher } = stripeApi();
    const url = await make(fetcher).createCheckoutSession({
      orgId: ORG,
      customerId: 'cus_1',
      priceId: 'price_1',
      quantity: 2,
      returnUrl: 'https://app.test/admin/billing',
      idempotencyKey: 'k',
    });
    expect(url).toBeDefined();
    const body = new URLSearchParams(calls[0]?.body);
    expect(calls[0]?.path).toBe('/checkout/sessions');
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('subscription_data[metadata][org_id]')).toBe(ORG);
    expect(body.get('line_items[0][quantity]')).toBe('2');
    expect(body.get('customer')).toBe('cus_1');
    expect(body.get('automatic_tax[enabled]')).toBe('true');
    expect(body.get('billing_address_collection')).toBe('required');
    expect(body.get('tax_id_collection[enabled]')).toBe('true');
    expect(body.get('customer_update[address]')).toBe('auto');
    expect(body.get('customer_update[name]')).toBe('auto');
  });

  it('omits customer_update when Checkout creates the customer', async () => {
    const { calls, fetcher } = stripeApi();
    await make(fetcher).createCheckoutSession({
      orgId: ORG,
      customerId: null,
      priceId: 'price_1',
      quantity: 1,
      returnUrl: 'https://app.test/admin/billing',
      idempotencyKey: 'k',
    });
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('automatic_tax[enabled]')).toBe('true');
    expect(body.has('customer_update[address]')).toBe(false);
  });

  it('starts a one-off credit Checkout and reads back only paid credit purchases', async () => {
    const { calls, fetcher } = stripeApi();
    const p = make(fetcher);
    await p.createTopUpSession({
      orgId: ORG,
      amountMinor: 2500,
      returnUrl: 'https://app.test/admin/billing',
      idempotencyKey: 'k',
    });
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('mode')).toBe('payment');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('2500');
    expect(body.get('metadata[purpose]')).toBe('sms_credit');
    expect(body.get('automatic_tax[enabled]')).toBe('true');
    expect(body.get('billing_address_collection')).toBe('required');
    expect(body.get('tax_id_collection[enabled]')).toBe('true');
    expect(body.get('line_items[0][price_data][tax_behavior]')).toBe('exclusive');
    const paid = {
      id: 'cs_1',
      payment_status: 'paid',
      amount_subtotal: 2500,
      amount_total: 2800, // includes 12% GST+PST; the tenant is credited only the pre-tax 2500
      total_details: { amount_tax: 300 },
      currency: 'usd',
      metadata: { org_id: ORG, purpose: 'sms_credit' },
    };
    const [topup] = await p.parseWebhook(
      await stripeWebhook('whsec', 'checkout.session.completed', paid),
    );
    expect(topup).toMatchObject({
      type: 'topup',
      orgId: ORG,
      sessionId: 'cs_1',
      amountMinor: 2500,
      currency: 'usd',
    });
    for (const o of [
      { ...paid, payment_status: 'unpaid' },
      { ...paid, metadata: { org_id: ORG } },
    ]) {
      await expect(
        p.parseWebhook(await stripeWebhook('whsec', 'checkout.session.completed', o)),
      ).resolves.toEqual([]);
    }
  });

  it('maps subscription and invoice events, and acknowledges the rest', async () => {
    const sub = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      metadata: { org_id: ORG },
      items: {
        data: [
          { id: 'si_1', quantity: 2, current_period_end: 1_700_000_000, price: { id: 'price_1' } },
        ],
      },
    };
    const p = make();
    const [created] = await p.parseWebhook(
      await stripeWebhook('whsec', 'customer.subscription.created', sub),
    );
    expect(created).toMatchObject({
      type: 'subscription',
      orgId: ORG,
      subscriptionId: 'sub_1',
      priceId: 'price_1',
      quantity: 2,
      status: 'active',
    });
    const [deleted] = await p.parseWebhook(
      await stripeWebhook('whsec', 'customer.subscription.deleted', sub),
    );
    expect(deleted?.type).toBe('deleted');
    const [failed] = await p.parseWebhook(
      await stripeWebhook('whsec', 'invoice.payment_failed', {
        subscription: 'sub_1',
        customer: 'cus_1',
      }),
    );
    expect(failed).toMatchObject({ type: 'payment_failed', subscriptionId: 'sub_1' });
    const [newer] = await p.parseWebhook(
      await stripeWebhook('whsec', 'invoice.payment_failed', {
        parent: { subscription_details: { subscription: 'sub_2' } },
      }),
    );
    expect(newer).toMatchObject({ subscriptionId: 'sub_2' });
    await expect(
      p.parseWebhook(await stripeWebhook('whsec', 'charge.succeeded', {})),
    ).resolves.toEqual([]);
    const [odd] = await p.parseWebhook(
      await stripeWebhook('whsec', 'customer.subscription.updated', {
        ...sub,
        metadata: { org_id: 'not-a-uuid' },
      }),
    );
    expect((odd as { orgId: string }).orgId).toBe('00000000-0000-0000-0000-000000000000');
  });

  describe('SMS bundle', () => {
    const makeBundle = () =>
      new StripeBillingProvider({
        secretKey: 'sk_test_1',
        webhookSecret: 'whsec',
        now: () => NOW,
        locationPriceIds: ['price_loc'],
        bundlePriceId: 'price_bundle',
      });
    const invoice = (over: Record<string, unknown> = {}) => ({
      id: 'in_1',
      subscription: 'sub_1',
      amount_paid: 1000,
      lines: { data: [{ price: { id: 'price_bundle' } }] },
      ...over,
    });
    const parse = (p: StripeBillingProvider, o: Record<string, unknown>, type = 'invoice.paid') =>
      stripeWebhook('whsec', type, o).then((r) => p.parseWebhook(r));

    it('turns a charged invoice with the bundle line into one grant event', async () => {
      const [e] = await parse(makeBundle(), invoice());
      expect(e).toMatchObject({ type: 'bundle_paid', invoiceId: 'in_1', subscriptionId: 'sub_1' });
    });

    it('reads the newer invoice shape', async () => {
      const [e] = await parse(
        makeBundle(),
        invoice({
          subscription: undefined,
          parent: { subscription_details: { subscription: 'sub_2' } },
          lines: { data: [{ pricing: { price_details: { price: 'price_bundle' } } }] },
        }),
      );
      expect(e).toMatchObject({ type: 'bundle_paid', subscriptionId: 'sub_2' });
    });

    it('ignores invoices that are free, without the bundle, or when no bundle price is configured', async () => {
      const p = makeBundle();
      await expect(parse(p, invoice({ amount_paid: 0 }))).resolves.toEqual([]);
      await expect(
        parse(p, invoice({ lines: { data: [{ price: { id: 'price_loc' } }] } })),
      ).resolves.toEqual([]);
      await expect(parse(p, invoice({ subscription: undefined }))).resolves.toEqual([]);
      await expect(parse(make(), invoice())).resolves.toEqual([]);
    });

    it('does not let the bundle item change the seat count or plan', async () => {
      const [e] = await parse(
        makeBundle(),
        {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          items: {
            data: [
              { id: 'si_b', quantity: 1, price: { id: 'price_bundle' } },
              { id: 'si_l', quantity: 4, price: { id: 'price_loc' } },
            ],
          },
        },
        'customer.subscription.updated',
      );
      expect(e).toMatchObject({ priceId: 'price_loc', quantity: 4 });
    });
  });

  it('rejects a wrong secret and a stale timestamp', async () => {
    const p = make();
    await expect(
      p.parseWebhook(await stripeWebhook('other', 'customer.subscription.created', {})),
    ).rejects.toThrow('invalid_signature');
    await expect(
      p.parseWebhook(await stripeWebhook('whsec', 'customer.subscription.created', {}, 600)),
    ).rejects.toThrow('invalid_signature');
    await expect(
      p.parseWebhook(new Request('https://x.test', { method: 'POST', body: '{}' })),
    ).rejects.toThrow('invalid_signature');
  });
});

describe('FakeBillingProvider', () => {
  const event: BillingEvent = {
    eventId: 'e1',
    at: '2026-10-31T12:00:00Z',
    type: 'payment_failed',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
  };

  it('repeats a quantity change for one idempotency key', async () => {
    const p = new FakeBillingProvider('s', () => NOW);
    await p.setQuantity('sub_1', 2, 'k1');
    await expect(p.setQuantity('sub_1', 9, 'k1')).resolves.toEqual({ quantity: 2 });
    expect(p.quantities.get('sub_1')).toBe(2);
    await expect(p.setQuantity('sub_1', -1, 'k2')).rejects.toMatchObject({ retryable: false });
  });

  it('accepts its own signed webhooks and rejects tampered or stale ones', async () => {
    const p = new FakeBillingProvider('s', () => NOW);
    await expect(p.parseWebhook(await p.signedWebhook([event]))).resolves.toEqual([event]);
    await expect(p.parseWebhook(await p.signedWebhook([event], NOW - 600_000))).rejects.toThrow(
      'invalid_signature',
    );
    const good = await p.signedWebhook([event]);
    await expect(
      p.parseWebhook(new Request(good.url, { method: 'POST', body: '[]', headers: good.headers })),
    ).rejects.toThrow('invalid_signature');
  });
});
