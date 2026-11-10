import { constantTimeEqual, hmacSha256Bytes, toBase64 } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

/** Svix replay window; a signed request older (or newer) than this is `stale`. */
export const TOLERANCE_SECONDS = 300;

/**
 * Svix (Resend): signature = base64(HMAC-SHA256(key, `${svix-id}.${svix-timestamp}.${body}`)) with
 * the key being the base64 part of the `whsec_...` secret; svix-signature carries one or more
 * space-separated `v1,<sig>` entries (several during a rotation).
 */
export const resend: WebhookVerifier = {
  provider: 'resend',
  async verify(req, secret, now) {
    const id = req.headers.get('svix-id');
    const timestamp = req.headers.get('svix-timestamp');
    const given = req.headers.get('svix-signature');
    if (!id || !timestamp || !given) return { ok: false, reason: 'missing' };
    const sent = Number(timestamp);
    if (!Number.isInteger(sent)) return { ok: false, reason: 'mismatch' };
    let key: Uint8Array;
    try {
      key = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
    } catch {
      return { ok: false, reason: 'mismatch' };
    }
    const signed = new TextEncoder().encode(`${id}.${timestamp}.`);
    const message = new Uint8Array(signed.length + req.rawBody.length);
    message.set(signed);
    message.set(req.rawBody, signed.length);
    if (key.length === 0) return { ok: false, reason: 'mismatch' };
    const expected = toBase64(await hmacSha256Bytes(key, message));
    // Compare every candidate so timing does not reveal which one matched.
    let match = false;
    for (const entry of given.split(' ')) {
      const [version, sig] = entry.split(',');
      if (version === 'v1' && sig && constantTimeEqual(expected, sig)) match = true;
    }
    if (!match) return { ok: false, reason: 'mismatch' };
    return Math.abs(now.getTime() / 1000 - sent) > TOLERANCE_SECONDS
      ? { ok: false, reason: 'stale' }
      : { ok: true };
  },
  eventKeys(_raw, _form, headers) {
    const id = headers?.get('svix-id');
    return id ? [id] : [];
  },
};
