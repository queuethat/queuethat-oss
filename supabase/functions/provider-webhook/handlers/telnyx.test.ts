// 3-SMS3 (#352): Telnyx signature check and event handling. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import fx from '../../../../tests/fixtures/webhooks/telnyx-event.json' with { type: 'json' };
import { createProviderWebhookHandler } from '../handler.ts';
import { createTelnyxHandler } from './telnyx.ts';

const ID = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';

function setup() {
  const log = { records: 0, applied: [] as unknown[][], inbound: [] as unknown[] };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    now: () => new Date((fx.t + 10) * 1000),
    async endpointSecrets() { return { orgId: 'org-a', secrets: [fx.publicKey] }; },
    async record() { log.records++; return { eventId: log.records, isDuplicate: false }; },
    async markProcessed() {},
    handlers: {
      telnyx: createTelnyxHandler(
        async (...a) => { log.applied.push(a); return true; },
        async (m) => { log.inbound.push(m); },
      ),
    },
  });
  const post = (body: string, signature: string, ts = String(fx.t)) =>
    handler(new Request(`${BASE}/provider-webhook/telnyx/${ID}`, {
      method: 'POST',
      headers: { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': ts },
      body,
    }));
  return { log, post };
}

Deno.test('a delivered event is verified, recorded once and applied for the endpoint org', async () => {
  const { log, post } = setup();
  assert.equal((await post(fx.body, fx.signature)).status, 200);
  assert.deepEqual(log.applied, [['org-a', 'telnyx', '40385f64-5717-4562-b3fc-2c963f66afa6', 'delivered', undefined]]);
});

Deno.test('a guest text is passed to the shared inbound path', async () => {
  const { log, post } = setup();
  assert.equal((await post(fx.inboundBody, fx.inboundSignature)).status, 200);
  assert.deepEqual(log.inbound, [{
    orgId: 'org-a', channel: 'sms', from: '+15558675310', to: '+15550000000', body: 'STOP',
    provider: 'telnyx', providerMessageId: 'in-1',
  }]);
});

Deno.test('AC2: a bad Ed25519 signature is 403 and writes nothing', async () => {
  const { log, post } = setup();
  for (const [body, sig] of [
    [fx.body.replace('delivered', 'failed'), fx.signature], // altered body
    [fx.body, fx.inboundSignature], // another message's signature
    [fx.body, 'AAAA'], // malformed
  ]) {
    const res = await post(body, sig);
    assert.equal(res.status, 403);
  }
  assert.equal(log.records, 0);
  assert.equal(log.applied.length, 0);
});

Deno.test('a valid signature outside five minutes is stale', async () => {
  const { log, post } = setup();
  const res = await post(fx.body, fx.signature);
  assert.equal(res.status, 200);
  const late = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    now: () => new Date((fx.t + 400) * 1000),
    async endpointSecrets() { return { orgId: 'org-a', secrets: [fx.publicKey] }; },
    async record() { log.records++; return { eventId: 9, isDuplicate: false }; },
    async markProcessed() {},
    handlers: {},
  });
  const stale = await late(new Request(`${BASE}/provider-webhook/telnyx/${ID}`, {
    method: 'POST', headers: { 'telnyx-signature-ed25519': fx.signature, 'telnyx-timestamp': String(fx.t) }, body: fx.body,
  }));
  assert.equal(stale.status, 403);
  assert.deepEqual(await stale.json(), { error: 'stale' });
});
