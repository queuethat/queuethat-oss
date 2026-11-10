// 3-SMS5 (#354): Plivo V3 signature check and event handling. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import fx from '../../../../tests/fixtures/webhooks/plivo-event.json' with { type: 'json' };
import { createProviderWebhookHandler } from '../handler.ts';
import { createPlivoHandler } from './plivo.ts';

const ID = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';

function setup() {
  const log = { records: 0, applied: [] as unknown[][], inbound: [] as unknown[] };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    async endpointSecrets() { return { orgId: 'org-a', secrets: [fx.secret] }; },
    async record() { log.records++; return { eventId: log.records, isDuplicate: false }; },
    async markProcessed() {},
    handlers: {
      plivo: createPlivoHandler(
        async (...a) => { log.applied.push(a); return true; },
        async (m) => { log.inbound.push(m); },
      ),
    },
  });
  const post = (params: Record<string, string>, signature?: string) =>
    handler(new Request(`${BASE}/provider-webhook/plivo/${ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature ? { 'x-plivo-signature-v3': signature, 'x-plivo-signature-v3-nonce': fx.nonce } : {}),
      },
      body: new URLSearchParams(params).toString(),
    }));
  return { log, post };
}

Deno.test('a delivered report is verified and applied for the endpoint org', async () => {
  const { log, post } = setup();
  assert.equal((await post(fx.params, fx.signature)).status, 200);
  assert.deepEqual(log.applied, [['org-a', 'plivo', 'db3ce55a-7f1d-11e1-8ea7-1231380c0f0b', 'delivered', undefined]]);
});

Deno.test('a guest text is passed to the shared inbound path with a plus on the numbers', async () => {
  const { log, post } = setup();
  assert.equal((await post(fx.inboundParams, fx.inboundSignature)).status, 200);
  assert.deepEqual(log.inbound, [{
    orgId: 'org-a', channel: 'sms', from: '+15558675310', to: '+15550000000', body: 'STOP',
    provider: 'plivo', providerMessageId: 'in-1',
  }]);
});

Deno.test('AC2: a bad V3 signature is 403 and writes nothing', async () => {
  const { log, post } = setup();
  for (const [params, sig] of [
    [fx.params, fx.wrongSecretSignature], // signed with another token
    [{ ...fx.params, Status: 'failed' }, fx.signature], // altered parameter
    [fx.params, fx.inboundSignature], // another request's signature
    [fx.params, undefined], // no signature
  ] as const) {
    const res = await post({ ...params }, sig);
    assert.equal(res.status, 403);
  }
  assert.equal(log.records, 0);
  assert.equal(log.applied.length, 0);
});
