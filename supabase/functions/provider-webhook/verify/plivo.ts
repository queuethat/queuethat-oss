import { constantTimeEqual, hmacSha256, toBase64 } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

/**
 * X-Plivo-Signature-V3 = base64(HMAC-SHA256(auth_token, url + sorted POST params as name+value +
 * "." + nonce)), with the nonce in X-Plivo-Signature-V3-Nonce. Plivo sends no timestamp, so replay
 * protection is the idempotent event key; the secret is the account's auth token.
 */
export const plivo: WebhookVerifier = {
  provider: 'plivo',
  async verify(req, secret) {
    const given = req.headers.get('x-plivo-signature-v3');
    const nonce = req.headers.get('x-plivo-signature-v3-nonce');
    if (!given || !nonce || !req.form) return { ok: false, reason: 'missing' };
    const keys = [...new Set(req.form.keys())].sort();
    const signed = `${req.publicUrl}${keys.map((k) => k + req.form!.getAll(k).join('')).join('')}.${nonce}`;
    // Plivo lists one signature per candidate token, comma separated.
    const expected = toBase64(await hmacSha256(secret, signed));
    return given.split(',').some((s) => constantTimeEqual(expected, s.trim())) ? { ok: true } : { ok: false, reason: 'mismatch' };
  },
  eventKeys(_raw, form) {
    const id = form?.get('MessageUUID');
    if (!id) return [];
    const status = form?.get('Status');
    return [status ? `${id}:${status}` : id];
  },
};
