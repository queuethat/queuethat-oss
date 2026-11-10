import { constantTimeEqual } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

const dec = new TextDecoder();

/**
 * Postmark signs nothing: the webhook URL is configured with HTTP basic auth, so the secret is
 * `user:password` and the request must carry exactly that. HTTPS keeps it off the wire.
 */
export const postmark: WebhookVerifier = {
  provider: 'postmark',
  verify(req, secret) {
    const given = req.headers.get('authorization');
    if (!given) return Promise.resolve({ ok: false, reason: 'missing' });
    let expected: string;
    try {
      expected = 'Basic ' + btoa(secret);
    } catch {
      return Promise.resolve({ ok: false, reason: 'mismatch' });
    }
    return Promise.resolve(constantTimeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'mismatch' });
  },
  /** `MessageID:RecordType`, so a Delivery and a later Bounce of one message are both processed. */
  eventKeys(raw) {
    try {
      const body = JSON.parse(dec.decode(raw));
      return typeof body?.MessageID === 'string' && typeof body?.RecordType === 'string'
        ? [`${body.MessageID}:${body.RecordType}`]
        : [];
    } catch {
      return [];
    }
  },
};
