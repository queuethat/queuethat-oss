import { constantTimeEqual, hmacSha1, toBase64 } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

/** X-Twilio-Signature = base64(HMAC-SHA1(auth_token, url + sorted form params as name+value)). */
export const twilio: WebhookVerifier = {
  provider: 'twilio',
  async verify(req, secret) {
    const given = req.headers.get('x-twilio-signature');
    if (!given || !req.form) return { ok: false, reason: 'missing' };
    const keys = [...new Set(req.form.keys())].sort();
    const signed = req.publicUrl + keys.map((k) => k + req.form!.getAll(k).join('')).join('');
    const expected = toBase64(await hmacSha1(secret, signed));
    return constantTimeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'mismatch' };
  },
  eventKeys(_raw, form) {
    const sid = form?.get('MessageSid') ?? form?.get('SmsSid');
    if (!sid) return [];
    const status = form?.get('MessageStatus');
    return [status ? `${sid}:${status}` : sid];
  },
};
