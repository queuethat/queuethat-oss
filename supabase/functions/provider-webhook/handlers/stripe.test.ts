// Run with `pnpm test:functions`. Fixture signed with node:crypto (tests/fixtures/webhooks/stripe-event.json).
import assert from 'node:assert/strict';
import stripeFx from '../../../../tests/fixtures/webhooks/stripe-event.json' with { type: 'json' };
import { createProviderWebhookHandler } from '../handler.ts';
import { type PaymentEventArgs, stripePaymentHandler } from './stripe.ts';

const ORG = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const ctx = (body: unknown) => ({
  provider: 'stripe', orgId: ORG, eventId: 1, eventKey: 'e', rawBody: new TextEncoder().encode(JSON.stringify(body)),
});

function collect() {
  const calls: PaymentEventArgs[] = [];
  const logs: string[] = [];
  const handler = stripePaymentHandler(async (a) => { calls.push(a); return 'applied'; }, (l) => logs.push(l));
  return { handler, calls, logs };
}
const event = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, data: { object } });

Deno.test('maps each handled event type', async () => {
  const { handler, calls } = collect();
  await handler(ctx(event('payment_intent.amount_capturable_updated', { id: 'pi_1', metadata: { org_id: ORG } })));
  await handler(ctx(event('payment_intent.succeeded', { id: 'pi_1' })));
  await handler(ctx(event('payment_intent.canceled', { id: 'pi_1' })));
  await handler(ctx(event('payment_intent.payment_failed', { id: 'pi_1' })));
  await handler(ctx(event('setup_intent.succeeded', { id: 'seti_1', customer: 'cus_1', payment_method: 'pm_1' })));
  await handler(ctx(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 400 })));
  assert.deepEqual(calls.map((c) => [c.type, c.objectId]), [
    ['authorized', 'pi_1'], ['succeeded', 'pi_1'], ['canceled', 'pi_1'], ['failed', 'pi_1'], ['setup_succeeded', 'seti_1'], ['refunded', 'pi_1'],
  ]);
  assert.equal(calls[0].metaOrg, ORG);
  assert.equal(calls[4].paymentMethodId, 'pm_1');
  assert.equal(calls[5].amountMinor, 400);
});

Deno.test('ignores other events and a malformed body', async () => {
  const { handler, calls } = collect();
  await handler(ctx(event('customer.created', { id: 'cus_1' })));
  await handler({ ...ctx({}), rawBody: new TextEncoder().encode('not json') });
  assert.equal(calls.length, 0);
});

Deno.test('a metadata org that is not a uuid is passed so it can never match', async () => {
  const { handler, calls } = collect();
  await handler(ctx(event('payment_intent.succeeded', { id: 'pi_1', metadata: { org_id: "x'; drop" } })));
  assert.equal(calls[0].metaOrg, '00000000-0000-0000-0000-000000000000');
});

Deno.test('AC3: the same signed event id twice applies once', async () => {
  const { handler, calls } = collect();
  const seen = new Set<string>();
  const wh = createProviderWebhookHandler({
    publicFunctionsUrl: 'https://example.test/functions/v1/',
    now: () => new Date((stripeFx.t + 10) * 1000),
    async endpointSecrets() { return { orgId: ORG, secrets: [stripeFx.secret] }; },
    async record(_p, key) { const dup = seen.has(key); seen.add(key); return { eventId: seen.size, isDuplicate: dup }; },
    async markProcessed() {},
    handlers: { stripe: handler },
  });
  const req = () => new Request(`https://example.test/functions/v1/provider-webhook/stripe/${ORG}`, {
    method: 'POST', headers: { 'stripe-signature': `t=${stripeFx.t},v1=${stripeFx.v1}` }, body: stripeFx.body,
  });
  assert.equal((await wh(req())).status, 200);
  assert.equal((await wh(req())).status, 200);
  assert.equal(calls.length, 1);
});
