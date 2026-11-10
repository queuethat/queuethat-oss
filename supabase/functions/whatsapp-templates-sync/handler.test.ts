// 3-WA4 (#361): whatsapp-templates-sync with fake dependencies. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createSyncHandler, type Mapping, type MetaTemplate, type SyncDeps } from './handler.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'EAAG-secret';
const maps: Mapping[] = [
  { id: 'm1', wa_name: 'queue_called', wa_language: 'en_US', wa_category: 'utility' },
  { id: 'm2', wa_name: 'promo', wa_language: 'en_US', wa_category: 'utility' },
  { id: 'm3', wa_name: 'gone', wa_language: 'en_US', wa_category: 'utility' },
];
const theirs: MetaTemplate[] = [
  { name: 'queue_called', language: 'en_US', status: 'REJECTED', category: 'UTILITY' },
  { name: 'promo', language: 'en_US', status: 'APPROVED', category: 'MARKETING' },
];

function harness(over: Partial<SyncDeps> = {}) {
  const written: Array<[string, string]> = [];
  const logs: string[] = [];
  const handle = createSyncHandler({
    isAdmin: async () => true,
    config: async () => ({ wabaId: '1', accessToken: TOKEN, graphVersion: 'v21.0' }),
    mappings: async () => maps,
    metaTemplates: async () => theirs,
    setStatus: async (_jwt, id, status) => { written.push([id, status]); },
    log: (line, cause) => logs.push(`${line} ${String(cause ?? '')}`),
    ...over,
  });
  const call = (body: unknown = { org_id: ORG }, headers: Record<string, string> = { authorization: 'Bearer jwt' }) =>
    handle(new Request('https://x.test/f', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { written, logs, call };
}

Deno.test('statuses come from Meta; a re-categorised template is paused; unknown ones are counted', async () => {
  const h = harness();
  const res = await h.call();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { updated: 2, missing: 1 });
  assert.deepEqual(h.written, [['m1', 'rejected'], ['m2', 'paused']]);
});

Deno.test('only owners and admins sync; nothing is read from Meta for anyone else', async () => {
  let asked = false;
  const h = harness({ isAdmin: async () => false, config: async () => { asked = true; return null; } });
  assert.equal((await h.call()).status, 403);
  assert.equal(asked, false);
});

Deno.test('input and auth errors', async () => {
  const h = harness();
  assert.equal((await h.call({ org_id: 'nope' })).status, 400);
  assert.equal((await h.call({ org_id: ORG }, {})).status, 401);
  assert.equal((await harness({ config: async () => null }).call()).status, 409);
});

Deno.test('a Meta outage is a 502 that never logs the token', async () => {
  const h = harness({ metaTemplates: async () => { throw new Error(`graph 500 ${TOKEN}`); } });
  assert.equal((await h.call()).status, 502);
  assert.equal(h.written.length, 0);
  assert.ok(h.logs.length > 0 && h.logs.every((l) => !l.includes(TOKEN)));
});
