// Run with `pnpm test:functions`. The flow itself is covered in square-oauth/handler.test.ts; this checks the HubSpot binding.
import assert from 'node:assert/strict';
import { createIntegrationOAuthHandler, type IntegrationOAuthDeps } from '../_shared/integration-oauth.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) =>
  new Request('https://x.test/hubspot-oauth', { method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify(body) });

function setup(channel: string, provider: string) {
  const exchanged: string[] = [];
  const saved: unknown[] = [];
  const deps: IntegrationOAuthDeps = {
    userId: async () => 'u1',
    begin: async () => 'state-1',
    config: async () => ({ application_id: 'hs', redirect_uri: 'https://app.example/cb' }),
    consume: async () => ({ org_id: ORG, channel, provider, config: {}, secrets: { application_secret: 's' } }),
    expect: { channel: 'crm', provider: 'hubspot' },
    authorizeUrl: (_c, state) => `https://app.hubspot.com/oauth/authorize?state=${state}`,
    exchange: async (_c, _s, code) => {
      exchanged.push(code);
      return { secrets: { access_token: 't' }, config: {} };
    },
    save: async (org, t) => { saved.push([org, t]); },
  };
  return { handler: createIntegrationOAuthHandler(deps), exchanged, saved };
}

Deno.test('a crm/hubspot state finishes and stores tokens', async () => {
  const { handler, saved } = setup('crm', 'hubspot');
  assert.equal((await handler(post({ action: 'finish', state: 's', code: 'c' }))).status, 200);
  assert.equal(saved.length, 1);
});

Deno.test('a Square state is refused before the code is exchanged', async () => {
  const { handler, exchanged, saved } = setup('pos', 'square');
  assert.equal((await handler(post({ action: 'finish', state: 's', code: 'c' }))).status, 404);
  assert.deepEqual(exchanged, []);
  assert.equal(saved.length, 0);
});
