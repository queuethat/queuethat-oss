import type { CaptchaEnv, CaptchaVerifier } from './verifier.ts';

const DEV_ENVIRONMENTS = ['local', 'development', 'dev', 'test'];

/**
 * Accepts every token. Local development only: construction throws unless ENVIRONMENT names a
 * development environment, so an unset or production value can never switch the CAPTCHA off.
 */
export function devAlwaysPassVerifier(env: CaptchaEnv = {}): CaptchaVerifier {
  if (!DEV_ENVIRONMENTS.includes(env.ENVIRONMENT ?? '')) {
    throw new Error(
      `DevAlwaysPassVerifier needs ENVIRONMENT to be one of ${DEV_ENVIRONMENTS.join(', ')}`,
    );
  }
  return { kind: 'dev', verify: async () => ({ ok: true }) };
}
