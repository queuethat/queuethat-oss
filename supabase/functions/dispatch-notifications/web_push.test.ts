// N4 (#70): webPushTransport against a local fake push service. Run with `pnpm test:functions`.
// (_shared has no deno.json, so the dispatcher, which imports the same file, runs it.)
import assert from 'node:assert/strict';
import { encodeBase64Url } from '@std/encoding/base64url';
import { vapidFromEnv, webPushTransport } from '../_shared/web-push.ts';

const subtle = crypto.subtle;

async function throwawayVapid() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: encodeBase64Url(raw), privateKey: jwk.d!, subject: 'mailto:ops@example.test' };
}

async function browserKeys() {
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    p256dh: encodeBase64Url(new Uint8Array(await subtle.exportKey('raw', ua.publicKey))),
    auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** Answers every push with `status` and records the request headers. */
function fakePushService(status: number) {
  const seen: Headers[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, async (req) => {
    seen.push(req.headers);
    await req.arrayBuffer();
    return new Response(status === 201 ? null : 'push subscription has unsubscribed or expired', {
      status,
    });
  });
  return { seen, server, endpoint: `http://127.0.0.1:${server.addr.port}/push/abc` };
}

const options = { ttlSeconds: 600, urgency: 'high' as const, topic: 'visit' };

Deno.test('sends an encrypted, VAPID-signed push with TTL, urgency and topic', async () => {
  const service = fakePushService(201);
  try {
    const send = webPushTransport(await throwawayVapid());
    const res = await send({ endpoint: service.endpoint, ...(await browserKeys()) }, '{"body":"hi"}', options);
    assert.deepEqual(res, { status: 201 });
    const h = service.seen[0]!;
    assert.equal(h.get('content-encoding'), 'aes128gcm');
    assert.match(h.get('authorization') ?? '', /^vapid t=.+, k=.+/);
    assert.equal(h.get('ttl'), '600');
    assert.equal(h.get('urgency'), 'high');
    assert.equal(h.get('topic'), 'visit');
  } finally {
    await service.server.shutdown();
  }
});

Deno.test('passes a 410 through so the channel reports the subscription gone', async () => {
  const service = fakePushService(410);
  try {
    const send = webPushTransport(await throwawayVapid());
    const res = await send({ endpoint: service.endpoint, ...(await browserKeys()) }, '{}', options);
    assert.equal(res.status, 410);
    assert.match(res.body ?? '', /unsubscribed/);
  } finally {
    await service.server.shutdown();
  }
});

Deno.test('answers status 0 without sending when the subscription keys are malformed', async () => {
  const service = fakePushService(201);
  try {
    const send = webPushTransport(await throwawayVapid());
    const res = await send({ endpoint: service.endpoint, p256dh: 'short', auth: 'a' }, '{}', options);
    assert.equal(res.status, 0);
    assert.equal(service.seen.length, 0);
  } finally {
    await service.server.shutdown();
  }
});

Deno.test('vapidFromEnv reads the three secrets and names a missing one', () => {
  const env: Record<string, string> = { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:x' };
  assert.deepEqual(vapidFromEnv((n) => env[n]), { publicKey: 'p', privateKey: 'k', subject: 'mailto:x' });
  assert.throws(() => vapidFromEnv(() => undefined), /VAPID_PUBLIC_KEY is not set/);
});
