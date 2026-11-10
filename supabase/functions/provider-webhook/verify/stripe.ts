import { constantTimeEqual, hmacSha256, toHex } from '../../_shared/hmac.ts';
import type { WebhookVerifier } from './types.ts';

const TOLERANCE_S = 300;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]; v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). */
export const stripe: WebhookVerifier = {
  provider: 'stripe',
  async verify(req, secret, now) {
    const header = req.headers.get('stripe-signature');
    if (!header) return { ok: false, reason: 'missing' };
    const parts = header.split(',').map((p) => p.trim().split('='));
    const t = parts.find(([k]) => k === 't')?.[1];
    const v1 = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    if (!t || !/^\d+$/.test(t) || v1.length === 0) return { ok: false, reason: 'missing' };
    const prefix = enc.encode(`${t}.`);
    const signed = new Uint8Array(prefix.length + req.rawBody.length);
    signed.set(prefix);
    signed.set(req.rawBody, prefix.length);
    const expected = toHex(await hmacSha256(secret, signed));
    if (!v1.some((s) => constantTimeEqual(expected, s))) return { ok: false, reason: 'mismatch' };
    return Math.abs(now.getTime() / 1000 - Number(t)) > TOLERANCE_S ? { ok: false, reason: 'stale' } : { ok: true };
  },
  eventKeys(raw) {
    try {
      const id = JSON.parse(dec.decode(raw))?.id;
      return typeof id === 'string' ? [id] : [];
    } catch {
      return [];
    }
  },
};
