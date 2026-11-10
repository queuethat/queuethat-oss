/// <reference lib="dom" />
/**
 * Webhook signatures, shared by the sender, the docs and the tests. The header is
 * `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; during a secret rotation the sender
 * adds one `v1=` per secret. A receiver rejects timestamps older than five minutes and dedupes on
 * the event id.
 */

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Compares without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The X-QM-Signature header for `body`. `secrets` is one secret, or two while one is rotating out. */
export async function signWebhook(
  secrets: string | string[],
  body: string,
  timestamp: number,
): Promise<string> {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const sigs = await Promise.all(list.map((s) => hmac(s, `${timestamp}.${body}`)));
  return [`t=${timestamp}`, ...sigs.map((s) => `v1=${s}`)].join(',');
}

/** True when some v1 signature matches and the timestamp is within `toleranceSeconds` of `now`. */
export async function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = options;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = await hmac(secret, `${t}.${body}`);
  let ok = false;
  for (const [k, v] of parts) if (k === 'v1' && sameText(v ?? '', expected)) ok = true;
  return ok;
}
