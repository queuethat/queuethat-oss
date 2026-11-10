import { hasLeadingZeroBits, powHash, powToken } from './pow.ts';
import { fromBase64Url } from './verifier.ts';

export interface SolveOptions {
  signal?: AbortSignal;
  /** Called about every 4096 hashes with the fraction of the expected work done (0..1, capped). */
  onProgress?: (fraction: number) => void;
}

/**
 * Finds the nonce for a challenge from `PowVerifier.issueChallenge` and returns the token to
 * send as `captcha`. Pure async code so it runs on the main thread or inside a Web Worker
 * (powWorker.ts). Expected work is 2^difficulty hashes: about 1-2 s at 16 bits on a phone.
 */
export async function solvePow(
  challenge: string,
  difficulty: number,
  opts: SolveOptions = {},
): Promise<string> {
  const body = challenge.split('.')[0] ?? '';
  const { s: salt } = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { s: string };
  const expected = 2 ** difficulty;
  for (let nonce = 0; ; nonce++) {
    if (nonce % 4096 === 0) {
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      opts.onProgress?.(Math.min(nonce / expected, 1));
      await Promise.resolve();
    }
    if (hasLeadingZeroBits(await powHash(salt, nonce), difficulty)) {
      return powToken(challenge, nonce);
    }
  }
}
