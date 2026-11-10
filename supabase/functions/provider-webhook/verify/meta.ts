import { constantTimeEqual, hmacSha256, toHex } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

const dec = new TextDecoder();

/** X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(app_secret, rawBody)). */
export const meta: WebhookVerifier = {
  provider: 'meta',
  async verify(req, secret) {
    const given = req.headers.get('x-hub-signature-256');
    if (!given) return { ok: false, reason: 'missing' };
    const expected = 'sha256=' + toHex(await hmacSha256(secret, req.rawBody));
    return constantTimeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'mismatch' };
  },
  /** Message ids, and `status.id:status.status` for delivery receipts. */
  eventKeys(raw) {
    try {
      const body = JSON.parse(dec.decode(raw));
      const keys: string[] = [];
      for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          for (const m of change?.value?.messages ?? []) if (typeof m?.id === 'string') keys.push(m.id);
          for (const s of change?.value?.statuses ?? []) {
            if (typeof s?.id === 'string' && typeof s?.status === 'string') keys.push(`${s.id}:${s.status}`);
          }
        }
      }
      return keys;
    } catch {
      return [];
    }
  },
};

/** The GET handshake: echo hub.challenge only when hub.verify_token is the endpoint's token. */
export function metaHandshake(params: URLSearchParams, verifyToken: string | undefined): string | null {
  const given = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (params.get('hub.mode') !== 'subscribe' || !verifyToken || !given || challenge === null) return null;
  return constantTimeEqual(given, verifyToken) ? challenge : null;
}
