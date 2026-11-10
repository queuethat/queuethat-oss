// HMAC helpers for webhook signatures. Web Crypto only, so Deno and Node tests share them.
const enc = new TextEncoder();

async function hmac(hash: 'SHA-1' | 'SHA-256', key: string, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(data)));
}

export const hmacSha1 = (key: string, data: Uint8Array | string) =>
  hmac('SHA-1', key, typeof data === 'string' ? enc.encode(data) : data);
export const hmacSha256 = (key: string, data: Uint8Array | string) =>
  hmac('SHA-256', key, typeof data === 'string' ? enc.encode(data) : data);

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** Compares in time independent of where the strings differ (length is not secret). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** HMAC-SHA256 with a binary key (Svix keys are base64-decoded). */
export async function hmacSha256Bytes(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(data)));
}
