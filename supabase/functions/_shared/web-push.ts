// Web push send path (K2 spike #29, kept by N4 #70). See docs/ops/web-push-spike.md.
//
// Wraps jsr:@negrel/webpush (WebCrypto only, no Node APIs). webPushTransport() adapts it to
// PushTransport from @qm/providers, which vapidWebPushChannel sends through. Functions that
// import this file map @negrel/webpush, @std/encoding and @qm/providers in their deno.json.
import * as webpush from '@negrel/webpush';
import { isPushEndpoint, type PushTransport } from '@qm/providers';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** VAPID keys in the base64url "raw" format that `web-push generate-vapid-keys` prints. */
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface SendOptions {
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
}

export type SendResult =
  | { ok: true; status: number }
  // gone: the subscription is dead (404/410) and must be deleted, never retried.
  | { ok: false; status: number; gone: boolean; body: string };

/**
 * Largest plaintext that fits one aes128gcm record inside the 4096-byte push
 * message limit: 4096 - 86 (header with 65-byte keyid) - 16 (tag) - 1 (padding delimiter).
 */
export const MAX_PAYLOAD_BYTES = 3993;

/**
 * Encrypts `payload` for one subscription (RFC 8291), signs a VAPID JWT
 * (RFC 8292) and POSTs it to the subscription's push service.
 * Throws only for caller errors (bad keys, oversized payload); every push
 * service answer comes back as a SendResult.
 */
export async function sendWebPush(
  subscription: PushSubscriptionJson,
  payload: string,
  vapid: VapidConfig,
  { ttlSeconds = 60 * 60, urgency = 'high', topic }: SendOptions = {},
): Promise<SendResult> {
  const message = new TextEncoder().encode(payload);
  if (message.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Payload is ${message.byteLength} bytes; max is ${MAX_PAYLOAD_BYTES}`);
  }
  // A new ApplicationServer per message, because the library keeps one ECDH key pair
  // per instance and RFC 8291 3.1 wants a fresh one for every message.
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: vapid.subject,
    vapidKeys: await importVapidKeys(vapid),
  });
  try {
    await appServer
      .subscribe(subscription)
      .pushMessage(message.buffer, { ttl: ttlSeconds, urgency: urgency as webpush.Urgency, topic });
    return { ok: true, status: 201 };
  } catch (err) {
    if (!(err instanceof webpush.PushMessageError)) throw err;
    const { status } = err.response;
    return { ok: false, status, gone: status === 404 || status === 410, body: await err.response.text() };
  }
}

/** Converts raw base64url VAPID keys to the CryptoKeyPair the library signs with. */
export function importVapidKeys(vapid: VapidConfig): Promise<CryptoKeyPair> {
  const pub = decodeBase64Url(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  if (decodeBase64Url(vapid.privateKey).length !== 32) {
    throw new Error('VAPID private key must be 32 bytes');
  }
  const x = encodeBase64Url(pub.slice(1, 33));
  const y = encodeBase64Url(pub.slice(33, 65));
  return webpush.importVapidKeys({
    publicKey: { kty: 'EC', crv: 'P-256', x, y, ext: true },
    privateKey: { kty: 'EC', crv: 'P-256', x, y, d: vapid.privateKey, ext: true },
  });
}

/** VAPID keys from the function's secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. */
export function vapidFromEnv(get: (name: string) => string | undefined = Deno.env.get): VapidConfig {
  const value = (name: string) => {
    const v = get(name);
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  return {
    publicKey: value('VAPID_PUBLIC_KEY'),
    privateKey: value('VAPID_PRIVATE_KEY'),
    subject: value('VAPID_SUBJECT'),
  };
}

/**
 * The library POSTs with the global fetch, which follows redirects. Requests to push services go
 * out with redirect: 'manual' instead, so a 3xx comes back as an answer and nothing is re-sent to
 * wherever it points. Installed once, by webPushTransport; other requests are untouched.
 */
let fetchGuarded = false;
function guardPushFetch() {
  if (fetchGuarded) return;
  fetchGuarded = true;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return original(input, isPushEndpoint(url) ? { ...init, redirect: 'manual' } : init);
  };
}

/** PushTransport for vapidWebPushChannel over sendWebPush. */
export function webPushTransport(vapid: VapidConfig): PushTransport {
  guardPushFetch();
  return async ({ endpoint, p256dh, auth }, payload, options) => {
    let result: SendResult;
    try {
      result = await sendWebPush({ endpoint, keys: { p256dh, auth } }, payload, vapid, options);
    } catch (err) {
      if (err instanceof TypeError) throw err; // fetch: no answer from the push service
      return { status: 0, body: 'subscription keys rejected' }; // malformed p256dh or auth
    }
    return result.ok ? { status: result.status } : { status: result.status, body: result.body };
  };
}
