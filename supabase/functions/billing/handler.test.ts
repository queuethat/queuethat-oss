// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { type BillingEvent, FakeBillingProvider, PaymentError } from '@qm/providers';
import { type BillingJob, type BillingReport, createBillingHandler, SessionError, type SessionInfo } from './handler.ts';

const KEY = 'dispatch-secret-0123456789abcdef0123';
const event: BillingEvent = {
  eventId: 'e1', at: '2026-10-31T12:00:00Z', type: 'payment_failed', customerId: 'cus_1', subscriptionId: 'sub_1',
};
const job = (over: Partial<BillingJob> = {}): BillingJob => ({
  id: 'job-1', org_id: 'o', stripe_subscription_id: 'sub_1', quantity: 3, attempts: 1, ...over,
});

function setup(jobs: BillingJob[] = [], applyResult = 'applied', info: SessionInfo | SessionError = { customerId: 'cus_1', subscriptionId: null, priceId: 'price_1', quantity: 2 }) {
  const provider = new FakeBillingProvider('x');
  const applied: BillingEvent[] = [];
  const reports: Array<[string, BillingReport]> = [];
  const intervals: string[] = [];
  let claimed = false;
  const handler = createBillingHandler({
    provider, secret: KEY, publicUrl: 'https://app.test',
    async sessionInfo(_t, _o, interval) { intervals.push(interval); if (info instanceof SessionError) throw info; return info; },
    async apply(e) { applied.push(e); return applyResult; },
    // Like the database: a job is handed to one caller only.
    async claim() { if (claimed) return []; claimed = true; return jobs; },
    async report(id, r) { reports.push([id, r]); },
  });
  const jobsCall = () => new Request('https://x.test/billing/jobs', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
  return { handler, provider, applied, reports, jobsCall, intervals };
}

Deno.test('a signed webhook is applied once per event', async () => {
  const { handler, provider, applied } = setup();
  const res = await handler(new Request(
    'https://x.test/billing/webhook',
    await provider.signedWebhook([event]).then((r) => ({ method: 'POST', headers: r.headers, body: JSON.stringify([event]) })),
  ));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { applied: 1, ignored: 0, rejected: 0 });
  assert.deepEqual(applied, [event]);
});

Deno.test('a bad signature writes nothing', async () => {
  const { handler, applied } = setup();
  const res = await handler(new Request('https://x.test/billing/webhook', { method: 'POST', body: '[]' }));
  assert.equal(res.status, 400);
  assert.equal(applied.length, 0);
});

Deno.test('events the database rejects are counted, not errors', async () => {
  const { handler, provider } = setup([], 'org_mismatch');
  const signed = await provider.signedWebhook([event]);
  const res = await handler(new Request('https://x.test/billing/webhook', { method: 'POST', headers: signed.headers, body: JSON.stringify([event]) }));
  assert.deepEqual(await res.json(), { applied: 0, ignored: 0, rejected: 1 });
});

Deno.test('a bundle invoice for a subscription not stored yet is retried by Stripe (500), other rejections are not', async () => {
  const bundle: BillingEvent = { eventId: 'e2', at: '2026-10-31T12:00:00Z', type: 'bundle_paid', invoiceId: 'in_1', subscriptionId: 'sub_1' };
  const { handler, provider } = setup([], 'unknown_subscription');
  const signed = await provider.signedWebhook([bundle]);
  const res = await handler(new Request('https://x.test/billing/webhook', { method: 'POST', headers: signed.headers, body: JSON.stringify([bundle]) }));
  assert.equal(res.status, 500);
  // the same answer for a payment_failed event is only counted: that subscription may be another integration's
  const other = setup([], 'unknown_subscription');
  const signed2 = await other.provider.signedWebhook([event]);
  const res2 = await other.handler(new Request('https://x.test/billing/webhook', { method: 'POST', headers: signed2.headers, body: JSON.stringify([event]) }));
  assert.equal(res2.status, 200);
});

Deno.test('AC1: a job asks Stripe for the quantity the database wants, with the job id as key', async () => {
  const { handler, provider, reports, jobsCall } = setup([job({ quantity: 3 })]);
  const res = await handler(jobsCall());
  assert.deepEqual(await res.json(), { claimed: 1, done: 1, failed: 0 });
  assert.equal(provider.quantities.get('sub_1'), 3);
  assert.deepEqual(reports, [['job-1', { ok: true, quantity: 3 }]]);
});

Deno.test('two concurrent invocations set the quantity once per job', async () => {
  const { handler, provider, reports, jobsCall } = setup([job()]);
  let calls = 0;
  const set = provider.setQuantity.bind(provider);
  provider.setQuantity = (s, q, k) => { calls++; return set(s, q, k); };
  await Promise.all([handler(jobsCall()), handler(jobsCall())]);
  assert.equal(calls, 1);
  assert.equal(reports.length, 1);
});

Deno.test('failures report the code and whether to retry, never the message', async () => {
  const { handler, provider, reports, jobsCall } = setup([job()]);
  provider.setQuantity = () => Promise.reject(new PaymentError('rate_limit', true, 'cus_secret leaked'));
  await handler(jobsCall());
  assert.deepEqual(reports, [['job-1', { ok: false, retryable: true, code: 'rate_limit' }]]);
});

Deno.test('jobs need the dispatch secret; other routes and methods are refused', async () => {
  const { handler } = setup([job()]);
  assert.equal((await handler(new Request('https://x.test/billing/jobs', { method: 'POST' }))).status, 401);
  assert.equal((await handler(new Request('https://x.test/billing/jobs', { method: 'POST', headers: { Authorization: 'Bearer nope' } }))).status, 401);
  assert.equal((await handler(new Request('https://x.test/billing/jobs'))).status, 405);
  assert.equal((await handler(new Request('https://x.test/billing/other', { method: 'POST' }))).status, 404);
});

const ORG = '6f1d2c3e-1111-4222-8333-444455556666';
const session = (route: string, init: RequestInit = {}) =>
  new Request(`https://x.test/billing/${route}`, {
    method: 'POST', headers: { Authorization: 'Bearer user-jwt', Origin: 'https://app.test' }, body: JSON.stringify({ org_id: ORG }), ...init,
  });

Deno.test('portal: the owner gets a Stripe link back to our billing page', async () => {
  const { handler } = setup();
  const res = await handler(session('portal'));
  assert.equal(res.status, 200);
  const { url } = await res.json();
  assert.match(url, /portal\/cus_1\?return=https%3A%2F%2Fapp.test%2Fadmin%2Fbilling$/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
});

Deno.test('AC2: no session for a non-owner, and the database refusal is the only gate', async () => {
  const { handler } = setup([], 'applied', new SessionError('permission_denied'));
  for (const route of ['portal', 'checkout']) assert.equal((await handler(session(route))).status, 403);
  assert.equal((await setup([], 'applied', new SessionError('not_found')).handler(session('portal'))).status, 404);
  assert.equal((await handler(session('portal', { headers: {} }))).status, 401);
});

Deno.test('portal needs a customer; checkout needs a price and no live subscription', async () => {
  const noCustomer = setup([], 'applied', { customerId: null, subscriptionId: null, priceId: 'p', quantity: 1 });
  assert.equal((await noCustomer.handler(session('portal'))).status, 409);
  const live = setup([], 'applied', { customerId: 'cus_1', subscriptionId: 'sub_1', priceId: 'p', quantity: 1 });
  assert.equal((await live.handler(session('checkout'))).status, 409);
  const noPrice = setup([], 'applied', { customerId: null, subscriptionId: null, priceId: null, quantity: 1 });
  assert.equal((await noPrice.handler(session('checkout'))).status, 503);
  const ok = await setup().handler(session('checkout'));
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).url, /checkout\/6f1d2c3e.*quantity=2/);
});

Deno.test('checkout takes an interval: month by default, year on request, nothing else', async () => {
  const { handler, intervals } = setup();
  assert.equal((await handler(session('checkout'))).status, 200);
  const year = await handler(session('checkout', { body: JSON.stringify({ org_id: ORG, interval: 'year' }) }));
  assert.equal(year.status, 200);
  assert.deepEqual(intervals, ['month', 'year']);
  const bad = await handler(session('checkout', { body: JSON.stringify({ org_id: ORG, interval: 'week' }) }));
  assert.equal(bad.status, 400);
  assert.deepEqual(intervals, ['month', 'year']);
});

Deno.test('a bad body is refused and a foreign origin gets no CORS grant', async () => {
  const { handler } = setup();
  assert.equal((await handler(session('portal', { body: '{"org_id":"nope"}' }))).status, 400);
  const res = await handler(session('portal', { headers: { Authorization: 'Bearer t', Origin: 'https://evil.test' } }));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'null');
  const pre = await handler(new Request('https://x.test/billing/portal', { method: 'OPTIONS', headers: { Origin: 'https://app.test' } }));
  assert.equal(pre.status, 204);
});

Deno.test('topup: only the offered amounts open a credit Checkout', async () => {
  const { handler } = setup();
  const ok = await handler(session('topup', { body: JSON.stringify({ org_id: ORG, amount_minor: 2500 }) }));
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).url, /topup\/6f1d2c3e.*amount=2500/);
  for (const amount of [1, 999999, '2500', undefined]) {
    const res = await handler(session('topup', { body: JSON.stringify({ org_id: ORG, amount_minor: amount }) }));
    assert.equal(res.status, 400);
  }
  const denied = setup([], 'applied', new SessionError('permission_denied'));
  assert.equal((await denied.handler(session('topup', { body: JSON.stringify({ org_id: ORG, amount_minor: 1000 }) }))).status, 403);
});
