// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { FakePaymentProvider } from '@qm/providers';
import { createPaymentIntentHandler, PlanError, type PaymentPlan } from './handler.ts';

const PUBLIC = 'https://app.example.test';
const PLAN: PaymentPlan = {
  payment_id: 'pay-1', org_id: 'org-1', kind: 'hold', amount_minor: 500, currency: 'usd', ref_id: 'ref-1',
  cancel_cutoff_hours: 24, release_after: 'served',
};

function setup(plan: PaymentPlan | PlanError = PLAN, allow = true) {
  const log = { begun: [] as string[], attached: [] as unknown[], created: [] as unknown[] };
  const fake = new FakePaymentProvider('x');
  const provider = {
    providerName: 'fake',
    createHold: (i: Parameters<FakePaymentProvider['createHold']>[0]) => { log.created.push(['hold', i]); return fake.createHold(i); },
    createDeposit: (i: Parameters<FakePaymentProvider['createDeposit']>[0]) => { log.created.push(['deposit', i]); return fake.createDeposit(i); },
    saveCard: (i: Parameters<FakePaymentProvider['saveCard']>[0]) => { log.created.push(['card', i]); return fake.saveCard(i); },
  } as unknown as FakePaymentProvider;
  const handler = createPaymentIntentHandler({
    provider,
    publishableKey: 'pk_test_1',
    publicUrl: PUBLIC,
    async begin(token) {
      log.begun.push(token);
      if (plan instanceof PlanError) throw plan;
      return plan;
    },
    async beginPos(token) {
      log.begun.push(`pos:${token}`);
      if (plan instanceof PlanError) throw plan;
      return plan;
    },
    async beginPosByCode(code) {
      log.begun.push(`code:${code}`);
      if (plan instanceof PlanError) throw plan;
      return plan;
    },
    async attach(...args) { log.attached.push(args); },
    async hit() { return allow; },
    async digest(v) { return `d-${v.length}`; },
  });
  return { handler, log };
}
const post = (body: unknown, origin: string | null = PUBLIC) =>
  new Request('https://x.test/payment-intent', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });

Deno.test('AC1: an amount in the request is ignored and the policy amount is used', async () => {
  const { handler, log } = setup();
  const res = await handler(post({ token: 'tok-12345678', idempotency_key: 'k1', amount_minor: 1, amount: 1, currency: 'eur' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.amount_minor, 500);
  assert.equal(body.currency, 'usd');
  assert.equal(body.publishable_key, 'pk_test_1');
  assert.ok(body.client_secret);
  assert.equal(body.cancel_cutoff_hours, 24);
  assert.equal(body.release_after, 'served');
  assert.deepEqual((log.created[0] as [string, { amountMinor: number; currency: string; idempotencyKey: string }])[1].amountMinor, 500);
  assert.equal((log.created[0] as [string, { idempotencyKey: string }])[1].idempotencyKey, 'pay-1');
  assert.equal((log.attached[0] as unknown[])[0], 'pay-1');
});

Deno.test('a far-off appointment saves a card instead of holding', async () => {
  const { handler, log } = setup({ ...PLAN, kind: 'card_on_file' });
  const res = await handler(post({ token: 'tok-12345678', idempotency_key: 'k1' }));
  assert.equal(res.status, 200);
  assert.equal((log.created[0] as unknown[])[0], 'card');
});

Deno.test('AC3: an unknown token is a 404 not_found with no provider call', async () => {
  const { handler, log } = setup(new PlanError('not_found'));
  const res = await handler(post({ token: 'unknown-token', idempotency_key: 'k1' }));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  assert.equal(log.created.length, 0);
});

Deno.test('no policy is 409, a bad body is 400, a flood is 429, a foreign origin is 403', async () => {
  assert.equal((await setup(new PlanError('payment_not_required')).handler(post({ token: 'tok-12345678', idempotency_key: 'k' }))).status, 409);
  assert.equal((await setup().handler(post({ token: 'x', idempotency_key: 'k' }))).status, 400);
  assert.equal((await setup(PLAN, false).handler(post({ token: 'tok-12345678', idempotency_key: 'k' }))).status, 429);
  assert.equal((await setup().handler(post({ token: 'tok-12345678', idempotency_key: 'k' }, 'https://evil.test'))).status, 403);
});

Deno.test('4-PAY1: a counter payment charges at once, needs no idempotency key and ignores a body amount', async () => {
  const { handler, log } = setup({ ...PLAN, kind: 'pos', amount_minor: 1800 });
  const res = await handler(post({ token: 'tok-12345678', pos: true, amount_minor: 1 }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, 'pos');
  assert.equal(body.amount_minor, 1800);
  assert.deepEqual(log.begun, ['pos:tok-12345678']);
  assert.equal((log.created[0] as unknown[])[0], 'deposit');
});

Deno.test('4-PAY1: nothing requested is 200 none and an unknown token 404, with no provider call', async () => {
  const none = setup(new PlanError('payment_not_required'));
  const res = await none.handler(post({ token: 'tok-12345678', pos: true }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { none: true });
  const unknown = setup(new PlanError('not_found'));
  assert.equal((await unknown.handler(post({ token: 'unknown-token', pos: true }))).status, 404);
  assert.equal(none.log.created.length + unknown.log.created.length, 0);
  assert.equal((await setup(PLAN, false).handler(post({ token: 'tok-12345678', pos: true }))).status, 429);
});

Deno.test('4-PAY2: a pay code opens the counter payment, charged at once, with no token', async () => {
  const { handler, log } = setup({ ...PLAN, kind: 'pos', amount_minor: 1800 });
  const res = await handler(post({ code: 'ABCD-EFGH', amount_minor: 1 }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, 'pos');
  assert.equal(body.amount_minor, 1800);
  assert.deepEqual(log.begun, ['code:ABCD-EFGH']);
  assert.equal((log.created[0] as unknown[])[0], 'deposit');
});

Deno.test('4-PAY2: an unknown, expired or paid code is one 404, never the none answer', async () => {
  const gone = setup(new PlanError('not_found'));
  assert.equal((await gone.handler(post({ code: 'ABCDEFGH' }))).status, 404);
  const paid = setup(new PlanError('payment_not_required'));
  assert.equal((await paid.handler(post({ code: 'ABCDEFGH' }))).status, 404);
});

Deno.test('4-PAY2: malformed codes are 400 and rate limits are 429', async () => {
  assert.equal((await setup().handler(post({ code: 'short' }))).status, 400);
  assert.equal((await setup().handler(post({ code: 'ABCD EFGH!!' }))).status, 400);
  assert.equal((await setup(PLAN, false).handler(post({ code: 'ABCDEFGH' }))).status, 429);
  assert.equal((await setup().handler(post({ code: 'ABCDEFGH' }, 'https://evil.test'))).status, 403);
});

Deno.test('4-PAY2: spellings of one code share a rate-limit bucket', async () => {
  const keys: string[] = [];
  const handler = createPaymentIntentHandler({
    provider: new FakePaymentProvider('x'), publishableKey: '', publicUrl: PUBLIC,
    async begin() { return PLAN; }, async beginPos() { return PLAN; }, async beginPosByCode() { return PLAN; },
    async attach() {}, async hit(key) { keys.push(key); return true; }, async digest(v) { return `d-${v}`; },
  });
  await handler(post({ code: 'abcd-23o5' }));
  await handler(post({ code: 'ABCD2305' }));
  const first = keys.filter((k) => k.startsWith('paycode:d-'));
  assert.equal(first[0], first[1]);
  assert.ok(keys.includes('paycode:all'));
});
