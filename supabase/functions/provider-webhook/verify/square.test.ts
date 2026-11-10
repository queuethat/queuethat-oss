// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createProviderWebhookHandler } from '../handler.ts';
import { squareHandler } from '../handlers/square.ts';

const ENDPOINT = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';
const URL_ = `${BASE}/provider-webhook/square/${ENDPOINT}`;
const KEY = 'square-signature-key-for-tests';
// Shape of Square's oauth.authorization.revoked notification (developer.squareup.com webhooks reference).
const BODY = JSON.stringify({
  merchant_id: 'MLSQ1', type: 'oauth.authorization.revoked', event_id: 'evt-revoke-1',
  data: { type: 'revocation', id: 'MLSQ1', object: { revocation: { revoked_at: '2026-10-30T10:00:00Z', revoker_type: 'MERCHANT' } } },
});
const sign = (body: string, url = URL_, key = KEY) => createHmac('sha256', key).update(url + body).digest('base64');

function setup() {
  const seen = new Set<string>();
  const log = { records: 0, revoked: [] as string[], secretReads: 0 };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    async endpointSecrets(provider, id) {
      log.secretReads++;
      return provider === 'square' && id === ENDPOINT ? { orgId: 'org-a', secrets: [KEY] } : null;
    },
    async record(p, key) {
      log.records++;
      const dup = seen.has(`${p}:${key}`);
      seen.add(`${p}:${key}`);
      return { eventId: seen.size, isDuplicate: dup };
    },
    async markProcessed() {},
    handlers: { square: squareHandler(async (org, merchant) => { log.revoked.push(`${org}:${merchant}`); }) },
  });
  return { handler, log };
}
const req = (body = BODY, sig = sign(BODY), url = URL_) =>
  new Request(url, { method: 'POST', headers: { 'x-square-hmacsha256-signature': sig, 'content-type': 'application/json' }, body });

Deno.test('AC2: a bad Square signature is 403 and writes nothing', async () => {
  const { handler, log } = setup();
  for (const r of [req(BODY, sign(BODY, URL_, 'wrong-key')), req(BODY, sign(BODY + ' ')), req(BODY, '')]) {
    const res = await handler(r);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'mismatch' });
  }
  assert.equal(log.records, 0);
  assert.deepEqual(log.revoked, []);
});

Deno.test('the signature covers the notification URL', async () => {
  const { handler, log } = setup();
  const res = await handler(req(BODY, sign(BODY, `${BASE}/provider-webhook/square/other`)));
  assert.equal(res.status, 403);
  assert.equal(log.records, 0);
});

Deno.test('a signed revocation switches the org off once, a replay does nothing', async () => {
  const { handler, log } = setup();
  assert.equal((await handler(req())).status, 200);
  assert.equal((await handler(req())).status, 200);
  assert.equal(log.records, 2);
  assert.deepEqual(log.revoked, ['org-a:MLSQ1']);
});

Deno.test('other signed events are recorded and ignored', async () => {
  const { handler, log } = setup();
  const other = JSON.stringify({ type: 'customer.updated', event_id: 'evt-2' });
  assert.equal((await handler(req(other, sign(other)))).status, 200);
  assert.deepEqual(log.revoked, []);
});

Deno.test('an unknown endpoint answers like a bad signature', async () => {
  const { handler } = setup();
  const url = `${BASE}/provider-webhook/square/0a1b2c3d-8d5a-4c55-9a1e-2b9f3c4d5e6f`;
  assert.equal((await handler(req(BODY, sign(BODY, url), url))).status, 403);
});
