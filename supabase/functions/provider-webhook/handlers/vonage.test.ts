// 3-SMS4 (#353): Vonage JWT check and event handling. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import fx from '../../../../tests/fixtures/webhooks/vonage-event.json' with { type: 'json' };
import { createProviderWebhookHandler } from '../handler.ts';
import { createVonageHandler } from './vonage.ts';

const ID = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';

function setup(nowS = fx.t + 10) {
  const log = { records: 0, applied: [] as unknown[][], inbound: [] as unknown[] };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    now: () => new Date(nowS * 1000),
    async endpointSecrets() { return { orgId: 'org-a', secrets: [fx.secret] }; },
    async record() { log.records++; return { eventId: log.records, isDuplicate: false }; },
    async markProcessed() {},
    handlers: {
      vonage: createVonageHandler(
        async (...a) => { log.applied.push(a); return true; },
        async (m) => { log.inbound.push(m); },
      ),
    },
  });
  const post = (body: string, auth?: string) =>
    handler(new Request(`${BASE}/provider-webhook/vonage/${ID}`, {
      method: 'POST', headers: auth ? { authorization: `Bearer ${auth}` } : {}, body,
    }));
  return { log, post };
}

Deno.test('a delivered report is verified and applied for the endpoint org', async () => {
  const { log, post } = setup();
  assert.equal((await post(fx.body, fx.jwt)).status, 200);
  assert.deepEqual(log.applied, [['org-a', 'vonage', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'delivered', undefined]]);
});

Deno.test('a guest text is passed to the shared inbound path with a plus on the numbers', async () => {
  const { log, post } = setup();
  assert.equal((await post(fx.inboundBody, fx.inboundJwt)).status, 200);
  assert.deepEqual(log.inbound, [{
    orgId: 'org-a', channel: 'sms', from: '+15558675310', to: '+15550000000', body: 'STOP',
    provider: 'vonage', providerMessageId: 'in-1',
  }]);
});

Deno.test('AC2: a JWT signed with the wrong secret, or for another body, is 403 and writes nothing', async () => {
  const { log, post } = setup();
  const [h, p] = fx.jwt.split('.');
  const none = `${btoa('{"alg":"none"}').replace(/=+$/, '')}.${p}.`;
  for (const [body, auth] of [
    [fx.body, fx.wrongSecretJwt],
    [fx.body.replace('delivered', 'failed'), fx.jwt], // payload_hash no longer matches
    [fx.body, none], // alg none
    [fx.body, `${h}.${p}`], // no signature
    [fx.body, undefined],
  ] as const) {
    assert.equal((await post(body, auth)).status, 403);
  }
  assert.equal(log.records, 0);
  assert.equal(log.applied.length, 0);
});

Deno.test('a valid JWT older than five minutes is stale', async () => {
  const res = await setup(fx.t + 400).post(fx.body, fx.jwt);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'stale' });
});
