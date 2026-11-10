import { constantTimeEqual, hmacSha256, toHex } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

const TOLERANCE_S = 300;
const dec = new TextDecoder();

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const parse = (s: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(dec.decode(Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
};

/**
 * `Authorization: Bearer <JWT>`: HS256 with the account's signature secret, whose `payload_hash`
 * claim is the SHA-256 (hex) of the raw body and `iat` is when it was signed.
 */
export const vonage: WebhookVerifier = {
  provider: 'vonage',
  async verify(req, secret, now) {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const [h, p, sig, extra] = token?.split('.') ?? [];
    if (!h || !p || !sig || extra !== undefined) return { ok: false, reason: 'missing' };
    // The algorithm is fixed to HS256: whatever the header claims (none, RS256) is not honoured.
    if (parse(h)?.alg !== 'HS256') return { ok: false, reason: 'mismatch' };
    if (!constantTimeEqual(b64url(await hmacSha256(secret, `${h}.${p}`)), sig)) return { ok: false, reason: 'mismatch' };
    const claims = parse(p);
    const hash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(req.rawBody))));
    if (typeof claims?.payload_hash !== 'string' || !constantTimeEqual(claims.payload_hash.toLowerCase(), hash)) {
      return { ok: false, reason: 'mismatch' };
    }
    const iat = Number(claims.iat);
    return !Number.isFinite(iat) || Math.abs(now.getTime() / 1000 - iat) > TOLERANCE_S ? { ok: false, reason: 'stale' } : { ok: true };
  },
  eventKeys(raw) {
    try {
      const e = JSON.parse(dec.decode(raw));
      return typeof e?.message_uuid === 'string' && e.message_uuid !== ''
        ? [typeof e.status === 'string' ? `${e.message_uuid}:${e.status}` : e.message_uuid]
        : [];
    } catch {
      return [];
    }
  },
};
