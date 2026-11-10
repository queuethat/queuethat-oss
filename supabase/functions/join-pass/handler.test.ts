// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createJoinPassHandler, HostnameRefusedError, turnstileVerifier } from './handler.ts';

function post(body: unknown): Request {
  return new Request('https://x/functions/v1/join-pass', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setup({ accept = true, issueFails = false, refuseHost = false } = {}) {
  const verified: string[] = [];
  const hosts: string[] = [];
  const handler = createJoinPassHandler({
    verify: (token) => {
      verified.push(token);
      return Promise.resolve(accept ? 'queue.example.com' : null);
    },
    issue: (hostname) => {
      hosts.push(hostname);
      if (refuseHost) return Promise.reject(new HostnameRefusedError('captcha_required'));
      return issueFails ? Promise.reject(new Error('rpc down')) : Promise.resolve('pass-1');
    },
  });
  return { handler, verified, hosts };
}

Deno.test('an accepted token gets a pass, checked against the hostname it was solved on', async () => {
  const { handler, verified, hosts } = setup();
  const res = await handler(post({ token: 'tok' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pass: 'pass-1' });
  assert.deepEqual(verified, ['tok']);
  assert.deepEqual(hosts, ['queue.example.com']);
});

Deno.test('a token solved on a hostname the deployment does not list gets captcha_required', async () => {
  const res = await setup({ refuseHost: true }).handler(post({ token: 'tok' }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'captcha_required' });
});

Deno.test('a rejected, missing or oversized token gets captcha_required and no pass', async () => {
  for (const [opts, body] of [
    [{ accept: false }, { token: 'tok' }],
    [{}, {}],
    [{}, { token: 42 }],
    [{}, { token: 'x'.repeat(2049) }],
  ] as const) {
    const { handler, hosts } = setup(opts);
    const res = await handler(post(body));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'captcha_required' });
    assert.deepEqual(hosts, []);
  }
});

Deno.test('a failure to issue is a 500, not a pass', async () => {
  const res = await setup({ issueFails: true }).handler(post({ token: 'tok' }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'unknown' });
});

Deno.test('only POST and the CORS preflight are answered', async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request('https://x/', { method: 'OPTIONS' }))).status, 204);
  assert.equal((await handler(new Request('https://x/'))).status, 405);
});

function fakeFetch(answer: () => Promise<Response>, seen: unknown[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    return await answer();
  }) as typeof fetch;
}

const answering = (body: unknown) => fakeFetch(() => Promise.resolve(Response.json(body)));

Deno.test('siteverify gets the secret and the token; success=true with a hostname is the only pass', async () => {
  const seen: unknown[] = [];
  const ok = turnstileVerifier(
    'sec',
    fakeFetch(() => Promise.resolve(Response.json({ success: true, hostname: 'q.example' })), seen),
  );
  assert.equal(await ok('tok'), 'q.example');
  assert.deepEqual(seen, [{ secret: 'sec', response: 'tok' }]);
  for (const body of [
    { success: false, hostname: 'q.example' },
    { success: 'true', hostname: 'q.example' },
    { success: true },
    { success: true, hostname: '' },
    { success: true, hostname: 42 },
  ]) {
    assert.equal(await turnstileVerifier('sec', answering(body))('tok'), null);
  }
});

Deno.test('siteverify failing or answering garbage fails closed', async () => {
  const down = turnstileVerifier('sec', fakeFetch(() => Promise.reject(new Error('timeout'))));
  assert.equal(await down('tok'), null);
  const html = turnstileVerifier('sec', fakeFetch(() => Promise.resolve(new Response('<html>'))));
  assert.equal(await html('tok'), null);
});
