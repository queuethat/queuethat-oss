// HMAC helpers shared by the payment adapters. Web Crypto only, so Deno and browsers work.
export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Checks a `Stripe-Signature` header (v1 HMAC-SHA256 over `t.body`, constant-time compare, 5-minute
 * tolerance) and throws `invalid_signature` on a bad, stale or missing one.
 */
export async function verifyStripeSignature(
  body: string,
  header: string,
  secret: string,
  nowMs: number,
): Promise<void> {
  const pairs = header.split(',').map((p) => p.split('=') as [string, string]);
  const timestamp = pairs.find(([k]) => k === 't')?.[1] ?? '';
  // Stripe sends several v1 values while a signing secret is being rotated; any one may match.
  const candidates = pairs.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v);
  if (
    !candidates.length ||
    !(Math.abs(nowMs / 1000 - Number(timestamp)) <= STRIPE_WEBHOOK_TOLERANCE_SECONDS)
  ) {
    throw new Error('invalid_signature');
  }
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  if (!candidates.some((c) => safeEqual(c, expected))) throw new Error('invalid_signature');
}
