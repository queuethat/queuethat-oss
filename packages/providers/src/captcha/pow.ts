import {
  encoder,
  fromBase64Url,
  toBase64Url,
  type CaptchaChallenge,
  type CaptchaVerifier,
} from './verifier.ts';

export const POW_TTL_MS = 2 * 60 * 1000;
export const POW_DEFAULT_DIFFICULTY = 16;
const MAX_DIFFICULTY = 28;

/** Remembers solved challenges so each can be used once. Back with a table to span instances. */
export interface SpentStore {
  /** Returns true when the key was newly recorded, false when it was already spent. */
  markSpent(key: string, expiresAtMs: number): Promise<boolean>;
}

/** Process-local store; fine for tests and a single Edge Function instance. */
export function memorySpentStore(now: () => number = Date.now): SpentStore {
  const spent = new Map<string, number>();
  return {
    async markSpent(key, expiresAtMs) {
      for (const [k, exp] of spent) if (exp <= now()) spent.delete(k);
      if (spent.has(key)) return false;
      spent.set(key, expiresAtMs);
      return true;
    },
  };
}

export interface PowOptions {
  /** PoW_SECRET: signs challenges. */
  secret: string;
  difficulty?: number;
  spent?: SpentStore;
  now?: () => number;
}

interface Payload {
  s: string; // salt
  e: number; // expires (ms epoch)
  d: number; // difficulty bits
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** True when the first `bits` bits of `hash` are zero. */
export function hasLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (hash[i] !== 0) return false;
  const rest = bits % 8;
  return rest === 0 || hash[full]! >> (8 - rest) === 0;
}

/** The puzzle: find a nonce so sha256(salt + nonce) has `difficulty` leading zero bits. */
export async function powHash(salt: string, nonce: string | number): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}${nonce}`)));
}

/** A client token is `${challenge}~${nonce}`. */
export function powToken(challenge: string, nonce: string | number): string {
  return `${challenge}~${nonce}`;
}

export function powVerifier(opts: PowOptions): CaptchaVerifier {
  const now = opts.now ?? Date.now;
  const spent = opts.spent ?? memorySpentStore(now);
  const difficulty = Math.min(opts.difficulty ?? POW_DEFAULT_DIFFICULTY, MAX_DIFFICULTY);
  return {
    kind: 'pow',
    async issueChallenge(): Promise<CaptchaChallenge> {
      const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const expires = now() + POW_TTL_MS;
      const body = toBase64Url(
        encoder.encode(JSON.stringify({ s: salt, e: expires, d: difficulty } satisfies Payload)),
      );
      const sig = toBase64Url(await hmac(opts.secret, body));
      return {
        challenge: `${body}.${sig}`,
        difficulty,
        expiresAt: new Date(expires).toISOString(),
      };
    },
    async verify(token) {
      const [challenge, nonce, extra] = token.split('~');
      if (!challenge || !nonce || extra !== undefined || nonce.length > 20) {
        return { ok: false, reason: 'malformed' };
      }
      const [body, sig, more] = challenge.split('.');
      if (!body || !sig || more !== undefined) return { ok: false, reason: 'malformed' };
      let payload: Payload;
      try {
        const expected = await hmac(opts.secret, body);
        if (!constantTimeEqual(expected, fromBase64Url(sig))) {
          return { ok: false, reason: 'bad_signature' };
        }
        payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Payload;
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (payload.e <= now()) return { ok: false, reason: 'expired' };
      // The signed difficulty is what counts; a looser configured value cannot weaken old puzzles.
      if (!hasLeadingZeroBits(await powHash(payload.s, nonce), Math.max(payload.d, 1))) {
        return { ok: false, reason: 'insufficient_work' };
      }
      // Spend last so a wrong nonce cannot burn someone else's valid challenge.
      if (!(await spent.markSpent(payload.s, payload.e))) return { ok: false, reason: 'spent' };
      return { ok: true };
    },
  };
}
