// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createIntegrationOAuthHandler, DbError, type IntegrationOAuthDeps } from '../_shared/integration-oauth.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown, auth = 'Bearer jwt-admin') =>
  new Request('https://x.test/square-oauth', { method: 'POST', headers: { Authorization: auth }, body: JSON.stringify(body) });

function setup(over: Partial<IntegrationOAuthDeps> = {}) {
  const saved: unknown[] = [];
  const spent = new Set<string>();
  const deps: IntegrationOAuthDeps = {
    userId: async (jwt) => (jwt === 'jwt-admin' ? 'user-1' : null),
    begin: async (jwt, org) => {
      if (jwt !== 'jwt-admin') throw new DbError('permission_denied');
      return `state-for-${org}`;
    },
    config: async () => ({ application_id: 'sq0idp-a' }),
    consume: async (state, uid) => {
      if (spent.has(state) || uid !== 'user-1' || !state.startsWith('state-for-')) throw new DbError('not_found');
      spent.add(state);
      return { org_id: ORG, channel: 'pos', provider: 'square', config: { application_id: 'sq0idp-a' }, secrets: { application_secret: 's' } };
    },
    expect: { channel: 'pos', provider: 'square' },
    authorizeUrl: (_c, state) => `https://connect.squareup.com/oauth2/authorize?state=${state}`,
    exchange: async (_c, _s, code) => (code === 'good' ? { secrets: { access_token: 'tok' }, config: { merchant_id: 'M' } } : null),
    save: async (org, t) => { saved.push([org, t]); },
    ...over,
  };
  return { handler: createIntegrationOAuthHandler(deps), saved };
}

Deno.test('no JWT or an unknown one gets 401 before anything runs', async () => {
  const { handler } = setup();
  assert.equal((await handler(post({ action: 'start', org_id: ORG }, ''))).status, 401);
  assert.equal((await handler(post({ action: 'start', org_id: ORG }, 'Bearer other'))).status, 401);
});

Deno.test('start returns the Square URL carrying the one-time state', async () => {
  const { handler } = setup();
  const res = await handler(post({ action: 'start', org_id: ORG }));
  assert.equal(res.status, 200);
  assert.match((await res.json()).url, /state=state-for-/);
});

Deno.test('start maps a database refusal to its status (a non-admin gets 403)', async () => {
  const { handler } = setup({ begin: async () => { throw new DbError('permission_denied'); } });
  assert.equal((await handler(post({ action: 'start', org_id: ORG }))).status, 403);
});

Deno.test('finish stores the tokens as verified, and the state works once', async () => {
  const { handler, saved } = setup();
  assert.equal((await handler(post({ action: 'finish', state: `state-for-${ORG}`, code: 'good' }))).status, 200);
  assert.equal(saved.length, 1);
  assert.equal((await handler(post({ action: 'finish', state: `state-for-${ORG}`, code: 'good' }))).status, 404);
  assert.equal(saved.length, 1);
});

Deno.test('finish with a state of another user is not found and saves nothing', async () => {
  const { handler, saved } = setup({ userId: async () => 'user-2' });
  assert.equal((await handler(post({ action: 'finish', state: 'state-for-x', code: 'good' }, 'Bearer any'))).status, 404);
  assert.equal(saved.length, 0);
});

Deno.test('a state minted for another vendor is not found and nothing is exchanged', async () => {
  let exchanged = 0;
  const { handler, saved } = setup({
    consume: async () => ({ org_id: ORG, channel: 'crm', provider: 'hubspot', config: {}, secrets: { client_secret: 'hs' } }),
    exchange: async () => { exchanged++; return null; },
  });
  assert.equal((await handler(post({ action: 'finish', state: 'state-for-z', code: 'good' }))).status, 404);
  assert.equal(exchanged, 0);
  assert.equal(saved.length, 0);
});

Deno.test('a code Square refuses saves nothing', async () => {
  const { handler, saved } = setup();
  assert.equal((await handler(post({ action: 'finish', state: 'state-for-y', code: 'bad' }))).status, 502);
  assert.equal(saved.length, 0);
});

Deno.test('malformed bodies are invalid_input', async () => {
  const { handler } = setup();
  assert.equal((await handler(post({ action: 'start', org_id: 'x' }))).status, 400);
  assert.equal((await handler(post({ action: 'finish', state: 5 }))).status, 400);
  assert.equal((await handler(post('nope'))).status, 400);
});
