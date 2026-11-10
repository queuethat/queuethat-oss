// Unsubscribe links (#479 follow-up): the link carries an outbox id and an HMAC of it, so nobody
// can unsubscribe an address they weren't mailed at. Plain WebCrypto, so the dispatcher, the
// unsubscribe function and the Node e2e suite share it. UNSUBSCRIBE_SECRET is at least 32
// characters and only the Edge Functions hold it.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The token for one outbox row: 128 bits of HMAC-SHA-256, base64url. */
export async function unsubscribeToken(secret: string, outboxId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`unsubscribe:${outboxId}`));
  return base64url(new Uint8Array(mac).slice(0, 16));
}

/** Constant-time check of a token from a link. False for a short secret, so a misconfig fails closed. */
export async function isUnsubscribeToken(
  secret: string,
  outboxId: string,
  token: string,
): Promise<boolean> {
  if (secret.length < 32) return false;
  const want = await unsubscribeToken(secret, outboxId);
  let diff = want.length ^ token.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (token.charCodeAt(i) || 0);
  return diff === 0;
}

/** `${base}?n=<outbox id>&t=<token>`, for both the confirm page and the one-click endpoint. */
export async function unsubscribeLink(base: string, secret: string, outboxId: string): Promise<string> {
  const url = new URL(base);
  url.searchParams.set('n', outboxId);
  url.searchParams.set('t', await unsubscribeToken(secret, outboxId));
  return url.toString();
}
