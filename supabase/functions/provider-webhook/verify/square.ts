import { constantTimeEqual, hmacSha256, toBase64 } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Square: x-square-hmacsha256-signature = base64(HMAC-SHA256(signature key, notification URL + raw body)).
 * The URL is the one registered in the Square app (our route, as `publicUrl`). There is no timestamp, so
 * replay protection is the event-id de-duplication in provider-webhook; the key is stored as
 * `signing_secret` in the org's pos provider settings.
 */
export const square: WebhookVerifier = {
  provider: 'square',
  async verify(req, secret) {
    const given = req.headers.get('x-square-hmacsha256-signature');
    if (!given) return { ok: false, reason: 'missing' };
    const url = enc.encode(req.publicUrl);
    const signed = new Uint8Array(url.length + req.rawBody.length);
    signed.set(url);
    signed.set(req.rawBody, url.length);
    const expected = toBase64(await hmacSha256(secret, signed));
    return constantTimeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'mismatch' };
  },
  eventKeys(raw) {
    try {
      const id = JSON.parse(dec.decode(raw))?.event_id;
      return typeof id === 'string' ? [id] : [];
    } catch {
      return [];
    }
  },
};
