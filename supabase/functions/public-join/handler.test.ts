// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { devAlwaysPassVerifier } from '../../../packages/providers/src/captcha/dev.ts';
import { powVerifier } from '../../../packages/providers/src/captcha/pow.ts';
import type { CaptchaVerifier } from '../../../packages/providers/src/captcha/verifier.ts';
import { createPublicJoinHandler, JoinError, networkOf, type PublicJoinDeps } from './handler.ts';

const QUEUE = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const LOCATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ORIGIN = 'https://queue.example.com';

function body(over: Record<string, unknown> = {}) {
  return {
    queueId: QUEUE,
    name: 'Sam',
    idempotencyKey: crypto.randomUUID(),
    captcha: 'ok',
    ...over,
  };
}

function post(over: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request('https://x/functions/v1/public-join', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body(over)),
  });
}

function setup(over: Partial<PublicJoinDeps> = {}, captcha: CaptchaVerifier = devAlwaysPassVerifier({ ENVIRONMENT: 'test' })) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const joins: unknown[] = [];
  const phoneCodes: string[] = [];
  const handler = createPublicJoinHandler({
    captcha,
    hit: (key, limit, _window, count = true) => {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + (count ? 1 : 0);
      counts.set(key, n);
      return Promise.resolve(count ? n <= limit : n < limit);
    },
    join: (args) => {
      joins.push(args);
      return Promise.resolve({ token: 'tok', display_ticket: 'A012', status: 'waiting' });
    },
    requestPhoneCode: (token) => {
      phoneCodes.push(token);
      return Promise.resolve({ state: 'sent', resend_after: '2026-10-30T12:04:00Z' });
    },
    hashIp: (ip) => Promise.resolve(`hash(${ip.length})`),
    publicUrl: ORIGIN,
    now: () => Date.UTC(2026, 9, 30, 12, 3, 20),
    ...over,
  });
  return { handler, counts, keys, joins, phoneCodes };
}

Deno.test('AC1: the 11th join from one IP in the window gets 429 with Retry-After and no visit', async () => {
  const { handler, joins } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await handler(post())).status, 200);
  const res = await handler(post());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '400'); // 600 s window, 3m20s in
  assert.equal(joins.length, 10);
});

Deno.test('AC2: a rejected captcha is 400 captcha_failed and creates no visit', async () => {
  const reject: CaptchaVerifier = { kind: 'turnstile', verify: () => Promise.resolve({ ok: false, reason: 'rejected' }) };
  const { handler, joins } = setup({}, reject);
  const res = await handler(post());
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'captcha_failed' });
  assert.equal(joins.length, 0);
});

Deno.test('AC3: a closed queue comes back as the database said it, with its detail', async () => {
  const { handler } = setup({
    join: () => Promise.reject(new JoinError('queue_not_accepting', 'paused')),
  });
  const res = await handler(post());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'queue_not_accepting', detail: 'paused' });
});

Deno.test('AC4: the raw IP never reaches the limiter or the join arguments', async () => {
  const { handler, keys } = setup();
  await handler(post());
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(!key.includes('203.0.113.7'), key);
});

Deno.test('the guest address is forwarded to the join only as a separate argument', async () => {
  let seen: string | null | undefined;
  const { handler } = setup({
    join: (_args, ip) => {
      seen = ip;
      return Promise.resolve({ token: null, display_ticket: 'A001', status: 'waiting' });
    },
  });
  await handler(post());
  assert.equal(seen, '203.0.113.7');
});

Deno.test('wrong on-site codes lock the IP out before the join is tried again', async () => {
  const { handler, joins } = setup({
    join: () => Promise.reject(new JoinError('onsite_code_invalid')),
    codeLimit: 3,
  });
  for (let i = 0; i < 3; i++) assert.equal((await handler(post({ onsiteCode: '0000' }))).status, 403);
  const res = await handler(post({ onsiteCode: '1111' }));
  assert.equal(res.status, 429);
  assert.equal(joins.length, 0);
});

Deno.test('requests from another origin, with extra fields or a large body are refused', async () => {
  const { handler, joins } = setup();
  assert.equal((await handler(post({}, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(post({ priority: 'vip' }))).status, 400);
  assert.equal((await handler(post({ name: 'x'.repeat(5000) }))).status, 400);
  assert.equal((await handler(post({ queueId: 'nope' }))).status, 400);
  // exactly one of queueId and locationId
  assert.equal((await handler(post({ queueId: QUEUE, locationId: LOCATION }))).status, 400);
  assert.equal((await handler(post({ queueId: null }))).status, 400);
  assert.equal(joins.length, 0);
});

Deno.test('only the configured header names the client, and it must be an address', async () => {
  const { handler, keys } = setup({ hashIp: (ip) => Promise.resolve(`h:${ip}`) });
  await handler(post({}, { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' }));
  assert.ok(keys.every((k) => k === 'join:h:203.0.113.7'), keys.join());
  const spoof = setup({ hashIp: (ip) => Promise.resolve(`h:${ip}`) });
  await spoof.handler(post({}, { 'x-real-ip': 'not an address; drop table' }));
  assert.ok(spoof.keys.every((k) => k === 'join:h:unknown'), spoof.keys.join());
  const cf = setup({ hashIp: (ip) => Promise.resolve(`h:${ip}`), clientIpHeader: 'cf-connecting-ip' });
  await cf.handler(post({}, { 'cf-connecting-ip': '2001:db8::1' }));
  assert.ok(cf.keys.every((k) => k === 'join:h:2001:db8::1'), cf.keys.join());
});

Deno.test('a body over the cap is refused even when it is chunked', async () => {
  const { handler, joins } = setup();
  const big = new TextEncoder().encode(JSON.stringify(body({ name: 'x'.repeat(8000) })));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(big.slice(0, 5000));
      controller.enqueue(big.slice(5000));
      controller.close();
    },
  });
  const res = await handler(new Request('https://x/functions/v1/public-join', {
    method: 'POST',
    headers: { origin: ORIGIN, 'x-real-ip': '203.0.113.7' },
    body: stream,
    // @ts-ignore Deno needs duplex for a streamed request body
    duplex: 'half',
  }));
  assert.equal(res.status, 400);
  assert.equal(joins.length, 0);
});

Deno.test('preflight allows only the public origin', async () => {
  const { handler } = setup();
  const ok = await handler(new Request('https://x/', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
});

Deno.test('GET /challenge issues a proof-of-work challenge only for the pow provider', async () => {
  const pow = powVerifier({ secret: 's', difficulty: 8 });
  const { handler } = setup({}, pow);
  const res = await handler(new Request('https://x/functions/v1/public-join/challenge', {
    headers: { origin: ORIGIN, 'x-real-ip': '203.0.113.7' },
  }));
  assert.equal(res.status, 200);
  const challenge = await res.json();
  assert.equal(challenge.difficulty, 8);
  const none = await setup().handler(new Request('https://x/public-join/challenge', { headers: { origin: ORIGIN } }));
  assert.equal(none.status, 404);
});

Deno.test('an unexpected failure is a bare 500', async () => {
  const { handler } = setup({ join: () => Promise.reject(new Error('db down')) });
  const res = await handler(post());
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'unknown' });
});

// C6 (#1272): a guest's intake answers are never logged or echoed, whatever the failure.
Deno.test('C6: answers reach neither the log nor the response when a join fails', async () => {
  const canary = 'CANARYNOTE7f3a91';
  const logged: unknown[][] = [];
  for (const failure of [new Error('db down'), new JoinError('invalid_answers', 'note')]) {
    const { handler } = setup({ join: () => Promise.reject(failure), error: (...args: unknown[]) => logged.push(args) } as Partial<PublicJoinDeps>);
    const res = await handler(post({ answers: { note: canary, mobile: '+14155550913' } }));
    const text = await res.text();
    assert.ok(!text.includes(canary) && !text.includes('+14155550913'), 'the response never echoes an answer');
  }
  assert.equal(logged.length, 1, 'only the unexpected failure is logged');
  assert.ok(!JSON.stringify(logged, (_k, v) => (v instanceof Error ? { message: v.message } : v)).includes(canary),
    'and the log line carries the failure, never the request');
});

Deno.test('a join for later passes p_arrive_after, and a bad time is 400', async () => {
  const { handler, joins } = setup();
  const at = '2026-10-30T15:00:00.000Z';
  assert.equal((await handler(post({ arriveAfter: at }))).status, 200);
  assert.equal((joins[0] as { p_arrive_after: unknown }).p_arrive_after, at);
  assert.equal((await handler(post({ arriveAfter: 'soon' }))).status, 400);
});

Deno.test('a location-level join passes p_location_id and no queue', async () => {
  const { handler, joins } = setup();
  assert.equal((await handler(post({ queueId: null, locationId: LOCATION }))).status, 200);
  assert.equal(joins.length, 1);
  assert.deepEqual(
    [(joins[0] as { p_queue_id: unknown }).p_queue_id, (joins[0] as { p_location_id: unknown }).p_location_id],
    [null, LOCATION],
  );
});

Deno.test('the position travels beside the join, never inside its arguments (2B-Q10)', async () => {
  let seen: unknown;
  const { handler, joins } = setup({
    join: (_args, _ip, geo) => {
      seen = geo;
      return Promise.resolve({ token: null, display_ticket: 'A001', status: 'waiting' });
    },
  });
  const res = await handler(post({ geo: { lat: 51.5, lng: -0.1, accuracyM: 20 } }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { lat: 51.5, lng: -0.1, accuracyM: 20 });
  assert.equal(joins.length, 0);
});

Deno.test('a malformed position is invalid_input', async () => {
  const { handler } = setup();
  for (const geo of [{ lat: 91, lng: 0, accuracyM: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 1, accuracyM: 1, x: 1 }, 'here']) {
    assert.equal((await handler(post({ geo }))).status, 400);
  }
});

Deno.test('wrong positions lock the IP out like wrong codes', async () => {
  const { handler } = setup({
    join: () => Promise.reject(new JoinError('onsite_required')),
    codeLimit: 2,
  });
  const geo = { lat: 1, lng: 1, accuracyM: 5 };
  for (let i = 0; i < 2; i++) assert.equal((await handler(post({ geo }))).status, 403);
  assert.equal((await handler(post({ geo }))).status, 429);
});

Deno.test('src is mapped to the allowlist; anything else is dropped (2B-J8)', async () => {
  const seen: unknown[] = [];
  const { handler } = setup({
    join: (_args, _ip, _geo, src) => {
      seen.push(src);
      return Promise.resolve({ token: null, display_ticket: 'A001', status: 'waiting' });
    },
  });
  for (const src of ['gbp', 'widget', 'poster', '<script>', 'GBP', 7, undefined]) {
    assert.equal((await handler(post({ src }))).status, 200);
  }
  assert.deepEqual(seen, ['gbp', 'widget', 'poster', null, null, null, null]);
});

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const codeRequest = (over: Record<string, unknown> = {}) =>
  new Request('https://x/functions/v1/public-join/phone-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': '203.0.113.7' },
    body: JSON.stringify({ token: TOKEN, captcha: 'ok', ...over }),
  });

Deno.test('phone code: a passed captcha reaches the database call with the token', async () => {
  const { handler, phoneCodes } = setup();
  const res = await handler(codeRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { state: 'sent', resend_after: '2026-10-30T12:04:00Z' });
  assert.deepEqual(phoneCodes, [TOKEN]);
});

Deno.test('phone code: a rejected captcha sends nothing', async () => {
  const reject: CaptchaVerifier = { kind: 'turnstile', verify: () => Promise.resolve({ ok: false, reason: 'rejected' }) };
  const { handler, phoneCodes } = setup({}, reject);
  const res = await handler(codeRequest());
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'captcha_failed' });
  assert.equal(phoneCodes.length, 0);
});

Deno.test('phone code: the 11th request from one IP in an hour is 429; junk bodies are 400 before any work', async () => {
  const { handler, phoneCodes } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await handler(codeRequest())).status, 200);
  assert.equal((await handler(codeRequest())).status, 429);
  assert.equal(phoneCodes.length, 10);
  const fresh = setup();
  assert.equal((await fresh.handler(codeRequest({ token: 'x' }))).status, 400);
  assert.equal((await fresh.handler(codeRequest({ extra: 1 }))).status, 400);
  assert.equal(fresh.phoneCodes.length, 0);
});

Deno.test('phone code: database refusals come back with their code', async () => {
  const { handler } = setup({ requestPhoneCode: () => Promise.reject(new JoinError('consent_required')) });
  const res = await handler(codeRequest());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'consent_required' });
});

Deno.test('phone code: IPv6 clients share one allowance per /64; a missing client address is refused', async () => {
  assert.equal(networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:DB8::1'), '2001:db8:0:0::/64');
  assert.equal(networkOf('::1'), '0:0:0:0::/64');
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  assert.equal(networkOf('2001:db8:1:2::1.2.3.4'), '2001:db8:1:2::/64');
  assert.equal(networkOf('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
  const { handler, phoneCodes } = setup({ hashIp: (ip) => Promise.resolve(`h:${ip}`) });
  const from = (ip: string) =>
    new Request('https://x/functions/v1/public-join/phone-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': ip },
      body: JSON.stringify({ token: TOKEN, captcha: 'ok' }),
    });
  for (let i = 0; i < 10; i++) assert.equal((await handler(from(`2001:db8:1:2::${i + 1}`))).status, 200);
  assert.equal((await handler(from('2001:db8:1:2:ffff::9'))).status, 429, 'another address in the same /64');
  assert.equal((await handler(from('2001:db8:1:3::1'))).status, 200, 'a different /64 is separate');
  const noIp = new Request('https://x/functions/v1/public-join/phone-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ token: TOKEN, captcha: 'ok' }),
  });
  const before = phoneCodes.length;
  assert.equal((await handler(noIp)).status, 403);
  assert.equal(phoneCodes.length, before);
});
