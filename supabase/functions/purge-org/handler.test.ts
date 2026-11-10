// 2P-PRV8 (#195). Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createPurgeOrgHandler, NotDueError, type PurgeOrgDeps } from './handler.ts';

const SECRET = 'purge-secret-0123456789abcdef0123456789';
const ORG = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';

function setup(over: Partial<PurgeOrgDeps> = {}) {
  const calls: string[] = [];
  const store: Record<string, string[]> = {
    logos: [`${ORG}/logo.png`, `${ORG}/old/logo2.png`],
    other: [],
  };
  const handler = createPurgeOrgHandler({
    secret: SECRET,
    targets: () => Promise.resolve(['u1', 'u2']),
    deleteUser: (id) => {
      calls.push(`user:${id}`);
      return Promise.resolve();
    },
    buckets: () => Promise.resolve(Object.keys(store)),
    listObjects: (bucket, prefix) => {
      calls.push(`list:${bucket}:${prefix}`);
      return Promise.resolve(store[bucket]!.filter((p) => p.startsWith(`${prefix}/`)));
    },
    removeObjects: (bucket, paths) => {
      calls.push(`rm:${bucket}:${paths.length}`);
      return Promise.resolve();
    },
    markDone: (id) => {
      calls.push(`done:${id}`);
      return Promise.resolve();
    },
    log: () => {},
    ...over,
  });
  const call = (headers: Record<string, string>, body: unknown = { org_id: ORG }) =>
    handler(new Request('http://x/', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { call, calls };
}

Deno.test('AC1: device users and the org prefix of every bucket are removed, then the database is told', async () => {
  const { call, calls } = setup();
  const res = await call({ Authorization: `Bearer ${SECRET}` });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { users: 2, objects: 2 });
  assert.deepEqual(calls, [
    'user:u1', 'user:u2', `list:logos:${ORG}`, 'rm:logos:2', `list:other:${ORG}`, `done:${ORG}`,
  ]);
});

Deno.test('AC2: a user JWT, the anon key or no header gets 403 and nothing happens', async () => {
  for (const auth of ['Bearer eyJhbGciOi.user.jwt', 'Bearer anon-key', '']) {
    const { call, calls } = setup();
    const res = await call(auth ? { Authorization: auth } : {});
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  }
});

Deno.test('a short secret means nobody may call', async () => {
  const { call } = setup({ secret: 'short' });
  assert.equal((await call({ Authorization: 'Bearer short' })).status, 403);
});

Deno.test('AC3: only the named org prefix is listed', async () => {
  const { call, calls } = setup();
  await call({ Authorization: `Bearer ${SECRET}` });
  assert.ok(calls.filter((c) => c.startsWith('list:')).every((c) => c.endsWith(`:${ORG}`)));
});

Deno.test('an org that is not due is 404 and nothing is deleted', async () => {
  const { call, calls } = setup({ targets: () => Promise.reject(new NotDueError()) });
  const res = await call({ Authorization: `Bearer ${SECRET}` });
  assert.equal(res.status, 404);
  assert.deepEqual(calls, []);
});

Deno.test('a bad body is 400 and a GET is 405', async () => {
  const { call } = setup();
  assert.equal((await call({ Authorization: `Bearer ${SECRET}` }, { org_id: 'nope' })).status, 400);
  const res = await createPurgeOrgHandler({ ...({} as PurgeOrgDeps), secret: SECRET })(new Request('http://x/'));
  assert.equal(res.status, 405);
});
