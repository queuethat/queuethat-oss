// Run with `pnpm test:functions`. Fixtures in tests/fixtures/webhooks/ were signed with node:crypto.
import assert from 'node:assert/strict';
import twilioFx from '../../../tests/fixtures/webhooks/twilio-inbound.json' with { type: 'json' };
import stripeFx from '../../../tests/fixtures/webhooks/stripe-event.json' with { type: 'json' };
import metaFx from '../../../tests/fixtures/webhooks/meta-event.json' with { type: 'json' };
import { createProviderWebhookHandler, type WebhookContext } from './handler.ts';

const A = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const B = '0a1b2c3d-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';

function setup(secrets: Record<string, string[]> = {}, verifyToken?: string) {
  const seen = new Set<string>();
  const log = { records: 0, handled: [] as WebhookContext[], processed: [] as Array<[number, string | undefined]>, secretReads: 0 };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE + '/',
    now: () => new Date((stripeFx.t + 10) * 1000),
    async endpointSecrets(_p, id) {
      log.secretReads++;
      return secrets[id] ? { orgId: `org-${id}`, secrets: secrets[id], verifyToken } : null;
    },
    async record(p, key) {
      log.records++;
      const dup = seen.has(`${p}:${key}`);
      seen.add(`${p}:${key}`);
      return { eventId: seen.size, isDuplicate: dup };
    },
    async markProcessed(id, err) { log.processed.push([id, err]); },
    handlers: { twilio: async (ctx) => { log.handled.push(ctx); }, stripe: async (ctx) => { log.handled.push(ctx); }, meta: async (ctx) => { log.handled.push(ctx); } },
  });
  return { handler, log };
}
const twilioReq = (id = A, params: Record<string, string> = twilioFx.params, sig = twilioFx.signature) =>
  new Request(`${BASE}/provider-webhook/twilio/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    body: new URLSearchParams(params).toString(),
  });
const stripeReq = (t = stripeFx.t) =>
  new Request(`${BASE}/provider-webhook/stripe/${A}`, {
    method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${stripeFx.v1}` }, body: stripeFx.body,
  });

Deno.test('AC1: a valid Twilio fixture is 200 and recorded once', async () => {
  const { handler, log } = setup({ [A]: ['old', twilioFx.secret] });
  const res = await handler(twilioReq());
  assert.equal(res.status, 200);
  assert.equal(log.records, 1);
  assert.equal(log.handled.length, 1);
  assert.equal(log.handled[0].eventKey, 'SM1111');
  assert.equal(log.handled[0].orgId, `org-${A}`);
  assert.deepEqual(log.processed, [[1, undefined]]);
});

Deno.test('AC2: one altered form parameter is 403 and writes nothing', async () => {
  const { handler, log } = setup({ [A]: [twilioFx.secret] });
  const res = await handler(twilioReq(A, { ...twilioFx.params, Body: 'START' }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'mismatch' });
  assert.equal(log.records, 0);
  assert.equal(log.handled.length, 0);
  assert.equal(log.processed.length, 0);
});

Deno.test('a missing signature header is 403 mismatch (no oracle)', async () => {
  const { handler, log } = setup({ [A]: [twilioFx.secret] });
  const req = new Request(`${BASE}/provider-webhook/twilio/${A}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b',
  });
  const res = await handler(req);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'mismatch' });
  assert.equal(log.records, 0);
});

Deno.test('the signed URL is the configured one, not the Host header', async () => {
  const { handler } = setup({ [A]: [twilioFx.secret] });
  const req = twilioReq();
  const behindProxy = new Request(req.url.replace('example.test', 'internal:54321'), req);
  assert.equal((await handler(behindProxy)).status, 200);
});

Deno.test('AC3: a Stripe fixture 301 s old is 403 stale; 300 s is accepted', async () => {
  const { handler, log } = setup({ [A]: [stripeFx.secret] });
  // setup()'s clock is t + 10: well inside the 300 s window
  assert.equal((await handler(stripeReq())).status, 200);
  const old = createProviderWebhookHandler({
    publicFunctionsUrl: BASE, now: () => new Date((stripeFx.t + 301) * 1000),
    endpointSecrets: async () => ({ orgId: 'o', secrets: [stripeFx.secret] }),
    record: async () => { log.records++; return { eventId: 9, isDuplicate: false }; },
    markProcessed: async () => {}, handlers: {},
  });
  const before = log.records;
  const res = await old(stripeReq());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'stale' });
  assert.equal(log.records, before);
});

Deno.test('AC4: Meta with a bad signature is 403; the handshake needs the right token', async () => {
  const { handler, log } = setup({ [A]: [metaFx.secret] }, 'verify-me');
  const bad = await handler(new Request(`${BASE}/provider-webhook/meta/${A}`, {
    method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: metaFx.body,
  }));
  assert.equal(bad.status, 403);
  assert.equal(log.records, 0);
  const q = (token: string) => `${BASE}/provider-webhook/meta/${A}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1234`;
  assert.equal((await handler(new Request(q('wrong')))).status, 403);
  const ok = await handler(new Request(q('verify-me')));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '1234');
  assert.equal(log.records, 0, 'a handshake records nothing');
});

Deno.test('a Meta delivery records one event per message and status', async () => {
  const { handler, log } = setup({ [A]: [metaFx.secret] });
  const res = await handler(new Request(`${BASE}/provider-webhook/meta/${A}`, {
    method: 'POST', headers: { 'x-hub-signature-256': metaFx.signature }, body: metaFx.body,
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(log.handled.map((h) => h.eventKey), ['wamid.AAA', 'wamid.BBB:delivered']);
});

Deno.test('AC5: a fixture replayed three times runs the handler once, all 200', async () => {
  const { handler, log } = setup({ [A]: [twilioFx.secret] });
  for (let i = 0; i < 3; i++) assert.equal((await handler(twilioReq())).status, 200);
  assert.equal(log.records, 3);
  assert.equal(log.handled.length, 1);
  assert.equal(log.processed.length, 1);
});

Deno.test("AC6: org A's endpoint with a request signed by org B's secret is 403", async () => {
  const { handler, log } = setup({ [A]: ['secret-a'], [B]: [twilioFx.secret] });
  assert.equal((await handler(twilioReq(A))).status, 403);
  assert.equal(log.records, 0);
  // and an unknown endpoint answers the same way
  const unknown = await handler(twilioReq('11111111-8d5a-4c55-9a1e-2b9f3c4d5e6f'));
  assert.equal(unknown.status, 403);
  assert.deepEqual(await unknown.json(), { error: 'mismatch' });
});

Deno.test('inherited object names are not providers', async () => {
  const { handler, log } = setup({ [A]: [twilioFx.secret] });
  assert.equal((await handler(new Request(`${BASE}/provider-webhook/constructor/${A}`, { method: 'POST' }))).status, 404);
  assert.equal(log.secretReads, 0);
});

Deno.test('unknown providers and malformed routes are 404 before any lookup', async () => {
  const { handler, log } = setup({ [A]: [twilioFx.secret] });
  assert.equal((await handler(new Request(`${BASE}/provider-webhook/nope/${A}`, { method: 'POST' }))).status, 404);
  assert.equal((await handler(new Request(`${BASE}/provider-webhook/twilio/not-a-uuid`, { method: 'POST' }))).status, 404);
  assert.equal(log.secretReads, 0);
});

Deno.test('a failing handler is recorded on the event and still answered 200', async () => {
  const processed: Array<[number, string | undefined]> = [];
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE, now: () => new Date(),
    endpointSecrets: async () => ({ orgId: 'o', secrets: [twilioFx.secret] }),
    record: async () => ({ eventId: 5, isDuplicate: false }),
    markProcessed: async (id, err) => { processed.push([id, err]); },
    handlers: { twilio: async () => { throw new TypeError('boom +14155550123'); } },
  });
  assert.equal((await handler(twilioReq())).status, 200);
  assert.deepEqual(processed, [[5, 'TypeError']], 'only the error type is stored, never its message');
});
