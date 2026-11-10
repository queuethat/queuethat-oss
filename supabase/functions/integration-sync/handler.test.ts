// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import type { IntegrationAdapter, IntegrationJob, SyncResult } from '@qm/providers';
import { createIntegrationSyncHandler, type IntegrationReport } from './handler.ts';

const KEY = 'dispatch-secret-0123456789abcdef0123';
const job = (over: Partial<IntegrationJob> = {}): IntegrationJob => ({
  id: 'j1', org_id: 'org-a', channel: 'pos', provider: 'square', config: {}, secrets: { access_token: 'tok-a' }, attempts: 0,
  visit: { id: 'v', ticket: 'A1', queue: 'Q', joined_at: null, serving_at: null, finished_at: null },
  contact: { channel: 'phone', value: '+14155550123', name: 'Gina' }, ...over,
});
const call = (auth = `Bearer ${KEY}`, method = 'POST') => new Request('https://x.test/integration-sync', { method, headers: { Authorization: auth } });

function setup(jobs: IntegrationJob[], result: SyncResult | Error) {
  const reports: Array<[string, IntegrationReport]> = [];
  const saved: unknown[] = [];
  const seen: IntegrationJob[] = [];
  const adapter: IntegrationAdapter = {
    provider: 'square',
    async sync(j) {
      seen.push(j);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  let claimed = false;
  const handler = createIntegrationSyncHandler({
    adapters: { square: adapter }, secret: KEY,
    async claim() { if (claimed) return []; claimed = true; return jobs; },
    async report(id, r) { reports.push([id, r]); },
    async saveTokens(org, channel, t) { saved.push([org, channel, t]); },
  });
  return { handler, reports, saved, seen };
}

Deno.test('a wrong or missing secret gets 401 and claims nothing', async () => {
  const { handler, seen } = setup([job()], { status: 'delivered' });
  assert.equal((await handler(call('Bearer nope'))).status, 401);
  assert.equal((await handler(call(''))).status, 401);
  assert.equal((await handler(call(`Bearer ${KEY}`, 'GET'))).status, 405);
  assert.equal(seen.length, 0);
});

Deno.test('a delivered job is reported once', async () => {
  const { handler, reports } = setup([job()], { status: 'delivered' });
  const res = await handler(call());
  assert.deepEqual(await res.json(), { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(reports, [['j1', { status: 'delivered' }]]);
});

Deno.test('refreshed tokens are saved before the report', async () => {
  const order: string[] = [];
  const handler = createIntegrationSyncHandler({
    adapters: { square: { provider: 'square', sync: async () => ({ status: 'delivered', refreshed: { secrets: { access_token: 'n' }, config: {} } }) } },
    secret: KEY,
    claim: async () => [job()],
    report: async () => { order.push('report'); },
    saveTokens: async () => { order.push('save'); },
  });
  await handler(call());
  assert.deepEqual(order, ['save', 'report']);
});

Deno.test('an adapter exception is reported as a bare code, retryable', async () => {
  const { handler, reports } = setup([job()], new Error('Gina +14155550123 not found'));
  await handler(call());
  assert.deepEqual(reports[0][1], { status: 'failed', error: 'unknown', retryable: true });
});

Deno.test('an unknown provider is dead-lettered without a call', async () => {
  const { handler, reports, seen } = setup([job({ provider: 'toast' })], { status: 'delivered' });
  await handler(call());
  assert.deepEqual(reports[0][1], { status: 'failed', error: 'no_adapter', retryable: false });
  assert.equal(seen.length, 0);
});

Deno.test('a vendor failure keeps its short code and retry flag', async () => {
  const { handler, reports } = setup([job()], { status: 'failed', error: 'unauthorized', retryable: false });
  const res = await handler(call());
  assert.deepEqual(await res.json(), { claimed: 1, delivered: 0, failed: 1 });
  assert.deepEqual(reports[0][1], { status: 'failed', error: 'unauthorized', retryable: false });
});
