// Verifies an X-QM-Signature header. Node 18+, no dependencies.
//   verifyWebhook(secret, rawBody, header) -> boolean
// Use the RAW request body (the exact bytes received), not a re-serialised object.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(secret, rawBody, header, toleranceSeconds = 300, now = Date.now() / 1000) {
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  // During a secret rotation the header carries one v1= value per secret; any match is valid.
  return parts.some(([k, v]) => {
    if (k !== 'v1' || !v || v.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}
