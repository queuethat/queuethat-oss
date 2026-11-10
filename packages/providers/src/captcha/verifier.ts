// CaptchaVerifier: provider-agnostic bot check for public joins (technical-design.md section 5).
// Same shape as NotificationChannel: an interface, a contract suite (contract.ts) and local
// implementations. Browser- and Deno-safe ESM: only WebCrypto and fetch, no Node imports.

export interface CaptchaChallenge {
  /** Opaque, signed string the client must solve and send back inside its token. */
  challenge: string;
  /** Leading zero bits the solution hash must have. */
  difficulty: number;
  expiresAt: string;
}

export interface CaptchaResult {
  ok: boolean;
  /** Short machine reason when ok is false: malformed, bad_signature, expired, spent, ... */
  reason?: string;
}

export interface CaptchaVerifier {
  readonly kind: 'turnstile' | 'pow' | 'dev';
  /** Only providers that need a server-issued puzzle (pow) implement it. */
  issueChallenge?(): Promise<CaptchaChallenge>;
  /**
   * Never throws and fails closed: a provider outage, timeout or malformed token returns
   * ok=false. `ipHash` is sha256(ip + daily salt); raw IPs never reach a verifier.
   */
  verify(token: string, ctx: { ipHash: string }): Promise<CaptchaResult>;
}

export type CaptchaEnv = Readonly<Record<string, string | undefined>>;

/** Hex/base64url helpers shared by the providers (WebCrypto only). */
export const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
