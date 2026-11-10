import { describe, expect, it } from 'vitest';
import { runCaptchaContract } from './contract.ts';
import { devAlwaysPassVerifier } from './dev.ts';
import { memorySpentStore, powVerifier } from './pow.ts';
import { solvePow } from './powSolver.ts';
import { turnstileVerifier } from './turnstile.ts';

const ctx = { ipHash: 'b'.repeat(64) };
const SECRET = 'test-pow-secret';

function pow(now: () => number = Date.now, difficulty = 8) {
  return powVerifier({ secret: SECRET, difficulty, now, spent: memorySpentStore(now) });
}

async function solved(v: ReturnType<typeof pow>) {
  const c = await v.issueChallenge!();
  return { c, token: await solvePow(c.challenge, c.difficulty) };
}

function turnstile(respond: (body: URLSearchParams) => Response | Promise<Response>) {
  return turnstileVerifier({
    secret: 's',
    fetch: (async (_url: unknown, init?: RequestInit) =>
      respond(init!.body as URLSearchParams)) as typeof fetch,
  });
}

runCaptchaContract('pow', async () => {
  const verifier = pow();
  return {
    verifier,
    validToken: async () => (await solved(verifier)).token,
    invalidToken: 'a.b~1',
  };
});
runCaptchaContract('turnstile', () => ({
  verifier: turnstile((body) => Response.json({ success: body.get('response') === 'good-token' })),
  validToken: async () => 'good-token',
  invalidToken: 'bad-token',
}));
runCaptchaContract('dev', () => ({
  verifier: devAlwaysPassVerifier({ ENVIRONMENT: 'development' }),
  validToken: async () => 'anything',
}));

describe('PowVerifier', () => {
  // AC 1 (#111)
  it('fails the second verify of the same solution as spent', async () => {
    const v = pow();
    const { token } = await solved(v);
    expect(await v.verify(token, ctx)).toEqual({ ok: true });
    expect(await v.verify(token, ctx)).toEqual({ ok: false, reason: 'spent' });
  });

  // AC 2 (#111)
  it('fails an expired challenge', async () => {
    let t = 1_000_000;
    const v = pow(() => t);
    const { token } = await solved(v);
    t += 2 * 60 * 1000 + 1;
    expect(await v.verify(token, ctx)).toEqual({ ok: false, reason: 'expired' });
  });

  it('fails a tampered challenge (difficulty or expiry edited)', async () => {
    const v = pow();
    const { c, token } = await solved(v);
    const [body, sig] = c.challenge.split('.');
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(body!)), d: 1 }));
    const nonce = token.split('~')[1];
    expect((await v.verify(`${forged}.${sig}~${nonce}`, ctx)).reason).toBe('bad_signature');
    expect((await v.verify(`${body}.${'A'.repeat(sig!.length)}~${nonce}`, ctx)).reason).toBe(
      'bad_signature',
    );
  });

  it('rejects a challenge signed with another secret', async () => {
    const other = powVerifier({ secret: 'other', difficulty: 8 });
    const { token } = await solved(other as ReturnType<typeof pow>);
    expect((await pow().verify(token, ctx)).reason).toBe('bad_signature');
  });

  it('rejects an insufficient nonce without spending the challenge', async () => {
    const v = pow(undefined, 16);
    const c = await v.issueChallenge!();
    expect((await v.verify(`${c.challenge}~0`, ctx)).reason).toBe('insufficient_work');
    const token = await solvePow(c.challenge, c.difficulty);
    expect(await v.verify(token, ctx)).toEqual({ ok: true });
    // Solving 16 bits is a random search: the mean is fast, the tail is not, and a loaded CI host hits it.
  }, 30_000);

  it('issues a 2 minute challenge at the configured difficulty', async () => {
    const t = Date.parse('2026-10-30T12:00:00Z');
    const c = await pow(() => t, 12).issueChallenge!();
    expect(c.difficulty).toBe(12);
    expect(c.expiresAt).toBe('2026-10-30T12:02:00.000Z');
  });

  it('reports progress and honours abort', async () => {
    const c = await pow(undefined, 12).issueChallenge!();
    const seen: number[] = [];
    await solvePow(c.challenge, c.difficulty, { onProgress: (f) => seen.push(f) });
    expect(seen[0]).toBe(0);
    const ctl = new AbortController();
    ctl.abort();
    await expect(solvePow(c.challenge, 30, { signal: ctl.signal })).rejects.toThrow();
  });
});

describe('TurnstileVerifier', () => {
  // AC 3 (#111)
  it('fails closed when siteverify times out', async () => {
    const v = turnstileVerifier({
      secret: 's',
      timeoutMs: 20,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) =>
          init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))),
        )) as typeof fetch,
    });
    expect(await v.verify('tok', ctx)).toEqual({ ok: false, reason: 'provider_unreachable' });
  });

  it('fails closed on a provider error status', async () => {
    const v = turnstile(() => new Response('no', { status: 503 }));
    expect(await v.verify('tok', ctx)).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('sends the secret and token, never the ip hash', async () => {
    let sent: URLSearchParams | undefined;
    const v = turnstile((b) => {
      sent = b;
      return Response.json({ success: true });
    });
    await v.verify('tok', ctx);
    expect(Object.fromEntries(sent!)).toEqual({ secret: 's', response: 'tok' });
  });
});

describe('DevAlwaysPassVerifier', () => {
  it('is refused in production and when ENVIRONMENT is unset', () => {
    expect(() => devAlwaysPassVerifier({ ENVIRONMENT: 'production' })).toThrow(/ENVIRONMENT/);
    expect(() => devAlwaysPassVerifier({})).toThrow(/ENVIRONMENT/);
    expect(() => devAlwaysPassVerifier()).toThrow(/ENVIRONMENT/);
  });
});
