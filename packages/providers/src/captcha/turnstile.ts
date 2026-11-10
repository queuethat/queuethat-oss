import type { CaptchaVerifier } from './verifier.ts';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 3000;

export interface TurnstileOptions {
  /** TURNSTILE_SECRET_KEY. Server side only. */
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Cloudflare Turnstile siteverify. Timeouts, network errors and non-2xx all fail closed. */
export function turnstileVerifier(opts: TurnstileOptions): CaptchaVerifier {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS;
  return {
    kind: 'turnstile',
    async verify(token) {
      if (!token) return { ok: false, reason: 'missing_token' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(TURNSTILE_VERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: opts.secret, response: token }),
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, reason: 'provider_error' };
        const body = (await res.json()) as { success?: boolean };
        return body.success === true ? { ok: true } : { ok: false, reason: 'rejected' };
      } catch {
        return { ok: false, reason: 'provider_unreachable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
