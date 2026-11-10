import type { WebhookVerifier } from './types.ts';

const TOLERANCE_S = 300;
const enc = new TextEncoder();
const dec = new TextDecoder();

const fromBase64 = (s: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/**
 * telnyx-signature-ed25519 = base64 Ed25519 signature of `${telnyx-timestamp}|${rawBody}`.
 * The endpoint's secret is the account's webhook public key (base64, 32 bytes).
 */
export const telnyx: WebhookVerifier = {
  provider: 'telnyx',
  async verify(req, secret, now) {
    const sig = req.headers.get('telnyx-signature-ed25519');
    const ts = req.headers.get('telnyx-timestamp');
    if (!sig || !ts || !/^\d+$/.test(ts)) return { ok: false, reason: 'missing' };
    const key = fromBase64(secret);
    const signature = fromBase64(sig);
    if (!key || key.length !== 32 || !signature || signature.length !== 64) return { ok: false, reason: 'mismatch' };
    const prefix = enc.encode(`${ts}|`);
    const signed = new Uint8Array(prefix.length + req.rawBody.length);
    signed.set(prefix);
    signed.set(req.rawBody, prefix.length);
    let valid = false;
    try {
      const pub = await crypto.subtle.importKey('raw', new Uint8Array(key), 'Ed25519', false, ['verify']);
      valid = await crypto.subtle.verify('Ed25519', pub, new Uint8Array(signature), new Uint8Array(signed));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: 'mismatch' };
    return Math.abs(now.getTime() / 1000 - Number(ts)) > TOLERANCE_S ? { ok: false, reason: 'stale' } : { ok: true };
  },
  eventKeys(raw) {
    try {
      const id = JSON.parse(dec.decode(raw))?.data?.id;
      return typeof id === 'string' && id !== '' ? [id] : [];
    } catch {
      return [];
    }
  },
};

