// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { FakePaymentProvider, type PaymentEvent } from '@qm/providers';
import { createPaymentWebhookHandler } from './handler.ts';

const EVENT: PaymentEvent = { eventId: 'evt_1', type: 'released', holdId: 'h1', at: new Date().toISOString() };

function setup(result: 'recorded' | 'duplicate' | 'unknown_hold' = 'recorded') {
  const provider = new FakePaymentProvider('whsec');
  const recorded: string[] = [];
  const handler = createPaymentWebhookHandler({
    provider,
    record: (_p, e) => {
      recorded.push(e.eventId);
      return Promise.resolve(result);
    },
  });
  return { provider, handler, recorded };
}

Deno.test('an invalid signature is 400 and nothing is recorded', async () => {
  const { provider, handler, recorded } = setup();
  const good = await provider.signedWebhook([EVENT]);
  const bad = new Request(good.url, { method: 'POST', headers: { 'x-fake-signature': '1:deadbeef' }, body: await good.text() });
  assert.equal((await handler(bad)).status, 400);
  assert.deepEqual(recorded, []);
});

Deno.test('a signed event is recorded', async () => {
  const { provider, handler, recorded } = setup();
  const res = await handler(await provider.signedWebhook([EVENT]));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { recorded: 1, duplicate: 0 });
  assert.deepEqual(recorded, ['evt_1']);
});

Deno.test('a replayed event is a 200 no-op', async () => {
  const { provider, handler } = setup('duplicate');
  const res = await handler(await provider.signedWebhook([EVENT]));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { recorded: 0, duplicate: 1 });
});

Deno.test('an unknown hold asks the provider to retry', async () => {
  const { provider, handler } = setup('unknown_hold');
  assert.equal((await handler(await provider.signedWebhook([EVENT]))).status, 503);
});

Deno.test('GET is 405', async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request('https://x/', { method: 'GET' }))).status, 405);
});

Deno.test('an unknown hold older than the grace period is acknowledged, not retried', async () => {
  const { provider, handler } = setup('unknown_hold');
  const old: PaymentEvent = { ...EVENT, at: '2020-01-01T00:00:00.000Z' };
  assert.equal((await handler(await provider.signedWebhook([old]))).status, 200);
});

Deno.test('a huge declared body is 413', async () => {
  const { handler } = setup();
  const res = await handler(new Request('https://x/', { method: 'POST', headers: { 'content-length': '1000000' }, body: '{}' }));
  assert.equal(res.status, 413);
});
