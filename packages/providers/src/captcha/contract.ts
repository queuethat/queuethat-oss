// Shared contract every CaptchaVerifier must pass. Import from '@qm/providers/captcha/contract'
// in a *.test.ts file; it needs Vitest, so it is not in the main entry.
import { describe, expect, it } from 'vitest';
import type { CaptchaVerifier } from './verifier.ts';

export interface CaptchaHarness {
  verifier: CaptchaVerifier;
  /** A token the provider accepts (once). */
  validToken(): Promise<string>;
  /** A token the provider rejects. Omit for providers that accept everything (dev). */
  invalidToken?: string;
}

const ctx = { ipHash: 'a'.repeat(64) };

export function runCaptchaContract(
  name: string,
  factory: () => CaptchaHarness | Promise<CaptchaHarness>,
): void {
  describe(`CaptchaVerifier contract: ${name}`, () => {
    it('names its kind', async () => {
      const h = await factory();
      expect(['turnstile', 'pow', 'dev']).toContain(h.verifier.kind);
    });

    it('accepts a valid token', async () => {
      const h = await factory();
      expect(await h.verifier.verify(await h.validToken(), ctx)).toEqual({ ok: true });
    });

    it('rejects an invalid token with a reason', async () => {
      const h = await factory();
      if (h.invalidToken === undefined) return; // dev accepts everything
      const result = await h.verifier.verify(h.invalidToken, ctx);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    });

    it('never throws on garbage input', async () => {
      const h = await factory();
      for (const token of ['', '~', '...', 'x'.repeat(5000)]) {
        await expect(h.verifier.verify(token, ctx)).resolves.toHaveProperty('ok');
      }
    });
  });
}
