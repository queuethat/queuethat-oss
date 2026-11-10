// Twilio Voice through the provider-webhook front door: signature, signed query string, TwiML replies.
import assert from 'node:assert/strict';
import { hmacSha1, toBase64 } from '../_shared/hmac.ts';
import { createProviderWebhookHandler } from './handler.ts';

const ID = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';
const TOKEN = 'auth-token-1';

async function signed(query: string, params: Record<string, string>, secret = TOKEN): Promise<Request> {
  const url = `${BASE}/provider-webhook/twilio-voice/${ID}${query}`;
  const signedText = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': toBase64(await hmacSha1(secret, signedText)) },
    body: new URLSearchParams(params).toString(),
  });
}

function setup(handle: () => Promise<{ body: string; contentType: string } | void>) {
  const log = { providers: [] as string[], handled: 0, processed: [] as Array<string | undefined> };
  const seen = new Set<string>();
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    async endpointSecrets(provider) {
      log.providers.push(provider);
      return { orgId: 'org-a', secrets: [TOKEN] };
    },
    async record(p, key) {
      const dup = seen.has(`${p}:${key}`);
      seen.add(`${p}:${key}`);
      return { eventId: seen.size, isDuplicate: dup };
    },
    async markProcessed(_id, err) { log.processed.push(err); },
    handlers: { 'twilio-voice': async () => { log.handled++; return await handle(); } },
  });
  return { handler, log };
}
const reply = { body: '<Response><Say>hi</Say></Response>', contentType: 'text/xml' };

Deno.test('a signed call is answered with the handler\'s TwiML; secrets are Twilio\'s', async () => {
  const { handler, log } = setup(async () => reply);
  const res = await handler(await signed('', { CallSid: 'CA1', From: '+14155550123' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/xml');
  assert.equal(await res.text(), reply.body);
  assert.deepEqual(log.providers, ['twilio']);
});

Deno.test('the query string is part of the signature: a changed step is 403 and runs nothing', async () => {
  const { handler, log } = setup(async () => reply);
  const params = { CallSid: 'CA1', From: '+14155550123', Digits: '1' };
  const good = await signed('?step=consent&visit=v1', params);
  const forged = new Request(good.url.replace('visit=v1', 'visit=v2'), { method: 'POST', headers: good.headers, body: new URLSearchParams(params).toString() });
  assert.equal((await handler(forged)).status, 403);
  assert.equal(log.handled, 0);
});

Deno.test('a retried keypress is answered again', async () => {
  const { handler, log } = setup(async () => reply);
  const params = { CallSid: 'CA1', From: '+14155550123', Digits: '1' };
  await handler(await signed('?step=join', params));
  const again = await handler(await signed('?step=join', params));
  assert.equal(await again.text(), reply.body);
  assert.equal(log.handled, 2);
  assert.equal(log.processed.length, 1, 'the event is marked processed once');
});

Deno.test('a failing handler hangs up politely instead of leaving silence', async () => {
  const { handler, log } = setup(async () => { throw new Error('db down'); });
  const res = await handler(await signed('', { CallSid: 'CA1', From: '+14155550123' }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /something went wrong[\s\S]*<Hangup\/>/);
  assert.equal(log.processed[0], 'Error');
});
