// 3-SMS2 (#351): reconcile-costs with fake Twilio and database. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import priced from '../../../tests/fixtures/providers/twilio/message-priced.json' with { type: 'json' };
import unpriced from '../../../tests/fixtures/providers/twilio/message-unpriced.json' with { type: 'json' };
import { createReconcileHandler, reconcile, type ReconcileDeps } from './handler.ts';

const KEY = 'dispatch-secret-0123456789abcdef0123';
const rows = [
  { id: 'n1', org_id: 'a', provider: 'twilio', provider_message_id: 'SM1' },
  { id: 'n2', org_id: 'a', provider: 'twilio', provider_message_id: 'SM2' },
  { id: 'n3', org_id: 'b', provider: 'twilio', provider_message_id: 'SM3' },
  { id: 'n4', org_id: 'a', provider: 'telnyx', provider_message_id: 'T4' },
];

function setup() {
  const applied: unknown[][] = [];
  let credLookups = 0;
  const deps: ReconcileDeps = {
    pending: async () => rows,
    credentials: async (org) => { credLookups++; return org === 'a' ? { accountSid: 'ACa', authToken: 't' } : null; },
    fetchMessage: async (_c, sid) => (sid === 'SM1' ? priced : unpriced),
    apply: async (...args) => { applied.push(args); },
    secret: KEY,
    log: () => {},
  };
  return { deps, applied, lookups: () => credLookups };
}

Deno.test('AC2: a -0.0079 USD price is applied; unpriced rows are only marked checked', async () => {
  const { deps, applied, lookups } = setup();
  assert.deepEqual(await reconcile(deps), { checked: 4, priced: 1, skipped: 2 });
  assert.deepEqual(applied, [['a', 'n1', -0.0079, 'USD'], ['a', 'n2', null, null]]);
  assert.equal(lookups(), 2, 'credentials are fetched once per org');
});

Deno.test('a Twilio error on one row does not stop the others', async () => {
  const { deps, applied } = setup();
  deps.fetchMessage = async (_c, sid) => { if (sid === 'SM1') throw new Error('twilio_500'); return priced; };
  assert.deepEqual(await reconcile(deps), { checked: 4, priced: 1, skipped: 3 });
  assert.equal(applied.length, 1);
});

Deno.test('only the dispatch secret may run it', async () => {
  const { deps } = setup();
  const h = createReconcileHandler(deps);
  const call = (auth?: string) => h(new Request('https://x.test/', { method: 'POST', headers: auth ? { Authorization: auth } : {} }));
  assert.equal((await call()).status, 401);
  assert.equal((await call('Bearer nope')).status, 401);
  assert.equal((await call(`Bearer ${KEY}`)).status, 200);
});
