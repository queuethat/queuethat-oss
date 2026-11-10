// 2P-NTF10 (#182): dev-sms-inbound handler with fake dependencies. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createDevSmsInboundHandler, type DevSmsInboundDeps } from './handler.ts';

const ORG = '22222222-2222-4222-8222-222222222222';
const BODY = { org_id: ORG, from_e164: '+14155550123', body: 'STOP' };

function fakes(overrides: Partial<DevSmsInboundDeps> = {}) {
  const calls: string[] = [];
  const deps: DevSmsInboundDeps = {
    enabled: true,
    authenticate: (jwt) => Promise.resolve(jwt === 'good' ? 'user-1' : null),
    record: (org, actor, from, body) => {
      calls.push(`record ${org} ${actor} ${from} ${body}`);
      return Promise.resolve('stop');
    },
    ...overrides,
  };
  return { calls, handle: createDevSmsInboundHandler(deps) };
}

const post = (body: unknown, auth: string | null = 'Bearer good') =>
  new Request('http://localhost/dev-sms-inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

Deno.test('AC2: disabled answers 404 and records nothing, whatever the request', async () => {
  const { calls, handle } = fakes({ enabled: false });
  for (const req of [post(BODY), post(BODY, null), post({}), new Request('http://localhost/x', { method: 'GET' })]) {
    const res = await handle(req);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
  assert.deepEqual(calls, []);
});

Deno.test('records the reply as the authenticated user and returns the action', async () => {
  const { calls, handle } = fakes();
  const res = await handle(post(BODY));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { action: 'stop' });
  assert.deepEqual(calls, [`record ${ORG} user-1 +14155550123 STOP`]);
});

Deno.test('a missing, invalid or throwing token is 401 and records nothing', async () => {
  const { calls, handle } = fakes({ authenticate: () => Promise.reject(new Error('boom')) });
  assert.equal((await handle(post(BODY, null))).status, 401);
  assert.equal((await handle(post(BODY))).status, 401);
  const other = fakes();
  assert.equal((await other.handle(post(BODY, 'Bearer bad'))).status, 401);
  assert.deepEqual([...calls, ...other.calls], []);
});

Deno.test('AC3: a database refusal maps to its status; other errors are 500 and logged without content', async () => {
  const logs: string[] = [];
  for (const [code, status] of [['not_found', 404], ['invalid_input', 400], ['weird', 500]] as const) {
    const { handle } = fakes({
      record: () => Promise.reject(new Error(code)),
      log: (line) => logs.push(line),
    });
    assert.equal((await handle(post(BODY))).status, status);
  }
  assert.deepEqual(logs, ['dev_record_inbound failed']);
});

Deno.test('malformed bodies are 400', async () => {
  const { calls, handle } = fakes();
  for (const bad of [{}, { ...BODY, org_id: 'x' }, { ...BODY, from_e164: 5 }, { ...BODY, body: null }]) {
    assert.equal((await handle(post(bad))).status, 400);
  }
  assert.deepEqual(calls, []);
});
