// 3-DOM1 (#370). Run with `pnpm test:functions`. DNS is a fake resolver; no network.
import assert from 'node:assert/strict';
import { createDomainCheckHandler, type DomainCheckDeps, type DomainToCheck, NotSignedInError, ResolverError } from './handler.ts';
import { dohTxt } from './deps.ts';
import type { DomainStatusChange } from './extensions.ts';

const SECRET = 'dispatch-secret-0123456789abcdef0123456789';
const ID = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const ORG = '0c9f2f7e-4a8d-4b61-8b0e-1d2c3b4a5f60';
const DOMAIN: DomainToCheck = { id: ID, org_id: ORG, hostname: 'book.barber-a.com', verification_token: 'a'.repeat(32), status: 'pending' };

function setup(over: Partial<DomainCheckDeps> = {}) {
  const state = { status: 'pending', records: [] as [string, boolean][] };
  const dns: Record<string, string[]> = {};
  const handler = createDomainCheckHandler({
    resolve: (host) => Promise.resolve(state.status === 'verified' && host === DOMAIN.hostname ? 'barber-a' : null),
    findForCaller: (jwt, id) => {
      if (jwt === 'expired') throw new NotSignedInError();
      return Promise.resolve(jwt === 'admin-a' && id === ID ? DOMAIN : null);
    },
    listVerified: () => Promise.resolve(state.status === 'verified' ? [{ ...DOMAIN, status: 'verified' as const }] : []),
    record: (id, ok) => {
      state.records.push([id, ok]);
      if (ok) state.status = 'verified';
      return Promise.resolve(ok ? 'verified' : 'failed');
    },
    txt: (name) => Promise.resolve(dns[name] ?? []),
    secret: SECRET,
    ...over,
  });
  const get = (host: string) => handler(new Request(`http://x/?host=${encodeURIComponent(host)}`));
  const post = (bearer: string | null, body: unknown = { domain_id: ID }) =>
    handler(new Request('http://x/', {
      method: 'POST',
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      body: JSON.stringify(body),
    }));
  return { get, post, dns, state };
}

Deno.test('AC1: an unverified host is a 404 with no body to learn from', async () => {
  const { get } = setup();
  const res = await get('book.barber-a.com');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

Deno.test('AC2: the right TXT token verifies, and then GET returns the slug', async () => {
  const { get, post, dns, state } = setup();
  dns['_queue-verify.book.barber-a.com'] = ['unrelated', DOMAIN.verification_token];
  const res = await post('admin-a');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'verified' });
  assert.deepEqual(state.records, [[ID, true]]);
  const asked = await get('Book.Barber-A.com:443');
  assert.equal(asked.status, 200);
  assert.deepEqual(await asked.json(), { location_slug: 'barber-a' });
});

Deno.test('a missing or wrong token records a failure', async () => {
  const { post, dns, state } = setup();
  dns['_queue-verify.book.barber-a.com'] = ['b'.repeat(32)];
  assert.deepEqual(await (await post('admin-a')).json(), { status: 'failed' });
  assert.deepEqual(state.records, [[ID, false]]);
});

Deno.test('AC4: someone who cannot see the domain gets 404, not a check', async () => {
  const { post, state } = setup();
  assert.equal((await post('admin-b')).status, 404);
  assert.deepEqual(state.records, []);
});

Deno.test('verify needs a signed-in caller; no header or an expired JWT is a 401', async () => {
  const { post } = setup();
  assert.equal((await post(null)).status, 401);
  assert.equal((await post('expired')).status, 401);
});

Deno.test('a resolver outage is a 502 and never counts as a failed check', async () => {
  const { post, state } = setup({ txt: () => Promise.reject(new ResolverError('down')) });
  assert.equal((await post('admin-a')).status, 502);
  assert.deepEqual(state.records, []);
});

Deno.test('the daily re-check needs the dispatch secret and checks every verified domain', async () => {
  const { post, dns, state } = setup();
  state.status = 'verified';
  assert.equal((await post('admin-a', {})).status, 400, 'a user JWT cannot run it');
  const res = await post(SECRET, {});
  assert.deepEqual(await res.json(), { checked: 1, failed: 1 });
  assert.deepEqual(state.records, [[ID, false]]);
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  assert.deepEqual(await (await post(SECRET, {})).json(), { checked: 1, failed: 0 });
});

Deno.test('a short secret means nobody may run the re-check', async () => {
  const { post } = setup({ secret: 'short' });
  assert.equal((await post('short', {})).status, 400);
});

Deno.test('junk hosts are a 404 and never reach the database', async () => {
  const { get } = setup({ resolve: () => Promise.reject(new Error('should not be called')) });
  for (const host of ['', 'a b', 'x/y', 'é.com', 'a'.repeat(300)]) assert.equal((await get(host)).status, 404, host);
});

Deno.test('dohTxt joins quoted chunks, treats NXDOMAIN as empty, and a bad status as a resolver fault', async () => {
  const answer = (body: unknown, status = 200) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;
  assert.deepEqual(
    await dohTxt(answer({ Status: 0, Answer: [{ type: 16, data: '"abc" "def"' }, { type: 5, data: 'x.' }] }))('n'),
    ['abcdef'],
  );
  assert.deepEqual(await dohTxt(answer({ Status: 3 }))('n'), []);
  await assert.rejects(dohTxt(answer({ Status: 2 }))('n'), ResolverError);
  await assert.rejects(dohTxt(answer({}, 503))('n'), ResolverError);
});

Deno.test('the status hook fires once per real change, with database values only', async () => {
  const changes: DomainStatusChange[] = [];
  const { post, dns } = setup({ onStatusChange: (c) => (changes.push(c), Promise.resolve()) });
  assert.equal((await post('admin-a')).status, 200); // no TXT record: pending to failed
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  assert.equal((await post('admin-a')).status, 200); // pending is still what the fake serves: to verified
  assert.deepEqual(changes, [
    { domainId: ID, orgId: ORG, hostname: 'book.barber-a.com', from: 'pending', to: 'failed' },
    { domainId: ID, orgId: ORG, hostname: 'book.barber-a.com', from: 'pending', to: 'verified' },
  ]);
});

Deno.test('a check that leaves the status as it was does not call the hook', async () => {
  const changes: DomainStatusChange[] = [];
  const { post, dns, state } = setup({
    onStatusChange: (c) => (changes.push(c), Promise.resolve()),
    findForCaller: () => Promise.resolve({ ...DOMAIN, status: 'verified' }),
  });
  state.status = 'verified';
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  assert.equal((await post('admin-a')).status, 200);
  assert.deepEqual(changes, []);
});

Deno.test('a hook that throws changes neither the answer nor the recorded check', async () => {
  const logs: string[] = [];
  const { post, dns, state } = setup({
    onStatusChange: () => Promise.reject(new Error('provider down')),
    log: (m) => logs.push(m),
  });
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  const res = await post('admin-a');
  assert.deepEqual(await res.json(), { status: 'verified' });
  assert.deepEqual(state.records, [[ID, true]]);
  assert.equal(logs.length, 1);
});

Deno.test('the daily re-check reports who is verified at its end, and survives a throwing hook', async () => {
  const seen: (readonly string[])[] = [];
  const { post, dns, state } = setup({ onRecheckComplete: (h) => (seen.push(h), Promise.resolve()) });
  state.status = 'verified';
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  assert.deepEqual(await (await post(SECRET, {})).json(), { checked: 1, failed: 0 });
  assert.deepEqual(seen, [['book.barber-a.com']]);

  const bad = setup({ onRecheckComplete: () => Promise.reject(new Error('boom')) });
  bad.state.status = 'verified';
  assert.equal((await bad.post(SECRET, {})).status, 200);
});

Deno.test("Caddy's ask sends ?domain=: a verified host answers 200, anything else 404", async () => {
  const { dns, post, state } = setup();
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  await post('admin-a');
  assert.equal(state.status, 'verified');
  const handler = createDomainCheckHandler({
    resolve: (host) => Promise.resolve(host === DOMAIN.hostname ? 'barber-a' : null),
    findForCaller: () => Promise.resolve(null),
    listVerified: () => Promise.resolve([]),
    record: () => Promise.resolve('verified'),
    txt: () => Promise.resolve([]),
    secret: SECRET,
  });
  const ask = (name: string) => handler(new Request(`http://x/?domain=${encodeURIComponent(name)}`));
  assert.equal((await ask('book.barber-a.com')).status, 200);
  assert.equal((await ask('evil.example')).status, 404);
  assert.equal((await handler(new Request('http://x/'))).status, 404);
});

Deno.test('names the database could never hold are refused before it is asked', async () => {
  let asked = 0;
  const { get } = setup({ resolve: () => (asked++, Promise.resolve(null)) });
  for (const host of ['localhost', '203.0.113.7', '[::1]', 'a..com', `${'a'.repeat(64)}.com`, 'x.123', '-a.com']) {
    assert.equal((await get(host)).status, 404, host);
  }
  assert.equal(asked, 0);
});

Deno.test('an unknown host is cached as unknown for a minute, and a check that verifies it clears that', async () => {
  let clock = 1_000;
  let asked = 0;
  const { get, post, dns, state } = setup({
    now: () => clock,
    resolve: (host) => (asked++, Promise.resolve(state.status === 'verified' && host === DOMAIN.hostname ? 'barber-a' : null)),
  });
  assert.equal((await get('book.barber-a.com')).status, 404);
  assert.equal((await get('book.barber-a.com')).status, 404);
  assert.equal(asked, 1, 'the second answer came from the cache');
  clock += 61_000;
  assert.equal((await get('book.barber-a.com')).status, 404);
  assert.equal(asked, 2, 'the cache expired');
  assert.equal((await get('book.barber-a.com')).status, 404);
  assert.equal(asked, 2);
  dns['_queue-verify.book.barber-a.com'] = [DOMAIN.verification_token];
  await post('admin-a');
  assert.equal((await get('book.barber-a.com')).status, 200, 'verifying drops the cached "unknown"');
});
