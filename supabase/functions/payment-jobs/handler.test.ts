// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { FakePaymentProvider, PaymentError } from '@qm/providers';
import { createPaymentJobsHandler, type PaymentJob, type PaymentReport, type StoredPayment } from './handler.ts';

const KEY = 'dispatch-secret-0123456789abcdef0123';
const stored = (over: Partial<StoredPayment> = {}): StoredPayment => ({
  kind: 'hold', intent_id: null, customer_id: null, payment_method_id: null, amount_minor: 500, currency: 'usd', org_id: 'o', ...over,
});
const job = (over: Partial<PaymentJob> = {}): PaymentJob => ({
  id: 'job-1', org_id: 'o', payment_id: 'p1', action: 'capture', amount_minor: null, attempts: 1, ...over,
});
const call = () => new Request('https://x.test/payment-jobs', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });

async function setup(jobs: PaymentJob[], payment: StoredPayment = stored()) {
  const provider = new FakePaymentProvider('x');
  const hold = await provider.createHold({ orgId: 'o', amountMinor: 500, currency: 'usd', refId: 'r', idempotencyKey: 'seed' });
  const reports: Array<[string, PaymentReport]> = [];
  let claimed = false;
  const handler = createPaymentJobsHandler({
    provider, secret: KEY,
    // Like the database: a job is handed to one caller only.
    async claim() { if (claimed) return []; claimed = true; return jobs; },
    async payment() { return { ...payment, intent_id: payment.intent_id ?? hold.intentId }; },
    async report(id, r) { reports.push([id, r]); },
  });
  return { handler, reports, provider, hold };
}

Deno.test('AC2: two concurrent invocations call the provider once per job', async () => {
  const { handler, reports, provider } = await setup([job({ action: 'release' })]);
  let releases = 0;
  const release = provider.release.bind(provider);
  provider.release = (id, key) => { releases++; return release(id, key); };
  await Promise.all([handler(call()), handler(call())]);
  assert.equal(releases, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1].ok, true);
});

Deno.test('captures with the job id as the provider idempotency key', async () => {
  const { handler, reports, provider } = await setup([job()]);
  let seen: string | undefined;
  const capture = provider.capture.bind(provider);
  provider.capture = (id, amount, key) => { seen = key; return capture(id, amount, key); };
  const res = await handler(call());
  assert.equal((await res.json()).done, 1);
  assert.equal(seen, 'job-1');
  assert.deepEqual(reports[0][1], { ok: true, status: 'captured', intent_id: reports[0][1].ok ? reports[0][1].intent_id : '' });
});

Deno.test('AC4: a provider failure is reported as retryable, and a permanent one is not', async () => {
  const a = await setup([job({ amount_minor: 99999 })]);
  await a.handler(call());
  assert.deepEqual(a.reports[0][1], { ok: false, retryable: false, code: 'amount_too_large' });

  const b = await setup([job()]);
  b.provider.capture = () => Promise.reject(new PaymentError('network', true));
  await b.handler(call());
  assert.deepEqual(b.reports[0][1], { ok: false, retryable: true, code: 'network' });
});

Deno.test('a saved-card charge without a stored card fails permanently', async () => {
  const { handler, reports } = await setup([job({ action: 'charge_no_show' })], stored({ kind: 'card_on_file' }));
  await handler(call());
  assert.deepEqual(reports[0][1], { ok: false, retryable: false, code: 'missing_prerequisite' });
});

Deno.test('rejects a missing or wrong secret', async () => {
  const { handler } = await setup([]);
  assert.equal((await handler(new Request('https://x.test', { method: 'POST' }))).status, 401);
});
