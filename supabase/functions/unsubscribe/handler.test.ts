// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { unsubscribeLink, unsubscribeToken } from '../_shared/unsubscribe-token.ts';
import { createUnsubscribeHandler } from './handler.ts';

const SECRET = 'unsubscribe-secret-0123456789abcdef';
const ID = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';

function setup(fail = false) {
  const calls: string[] = [];
  const handler = createUnsubscribeHandler({
    secret: SECRET,
    unsubscribe: (id) => {
      calls.push(id);
      return fail ? Promise.reject(new Error('rpc down')) : Promise.resolve();
    },
  });
  return { handler, calls };
}

Deno.test('a one-click POST with a valid link unsubscribes', async () => {
  const { handler, calls } = setup();
  const link = await unsubscribeLink('https://x/functions/v1/unsubscribe', SECRET, ID);
  const res = await handler(new Request(link, { method: 'POST', body: 'List-Unsubscribe=One-Click' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'unsubscribed' });
  assert.deepEqual(calls, [ID]);
});

Deno.test('the confirm page may send the link as JSON', async () => {
  const { handler, calls } = setup();
  const t = await unsubscribeToken(SECRET, ID);
  const res = await handler(
    new Request('https://x/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: ID, t }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [ID]);
});

Deno.test('a tampered, foreign or missing token writes nothing', async () => {
  const { handler, calls } = setup();
  const good = await unsubscribeToken(SECRET, ID);
  const other = '00000000-0000-4000-8000-000000000000';
  for (const query of [
    `n=${ID}&t=${good.slice(0, -1)}A`,
    `n=${other}&t=${good}`,
    `n=${ID}&t=${await unsubscribeToken('another-secret-0123456789abcdef0', ID)}`,
    `n=${ID}`,
    `n=not-a-uuid&t=${good}`,
  ]) {
    const res = await handler(new Request(`https://x/?${query}`, { method: 'POST' }));
    assert.equal(res.status, 400, query);
  }
  assert.deepEqual(calls, []);
});

Deno.test('GET never unsubscribes, so link scanners are harmless', async () => {
  const { handler, calls } = setup();
  const res = await handler(new Request(await unsubscribeLink('https://x/', SECRET, ID)));
  assert.equal(res.status, 405);
  assert.deepEqual(calls, []);
});

Deno.test('a short secret disables every link', async () => {
  const calls: string[] = [];
  const handler = createUnsubscribeHandler({ secret: 'short', unsubscribe: (id) => (calls.push(id), Promise.resolve()) });
  const res = await handler(new Request(await unsubscribeLink('https://x/', 'short', ID), { method: 'POST' }));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

Deno.test('a broken RPC is a 500', async () => {
  const { handler } = setup(true);
  const res = await handler(new Request(await unsubscribeLink('https://x/', SECRET, ID), { method: 'POST' }));
  assert.equal(res.status, 500);
});

Deno.test('a link signed with the previous secret still works after a rotation', async () => {
  const calls: string[] = [];
  const handler = createUnsubscribeHandler({
    secret: 'rotated-secret-0123456789abcdef0123',
    previousSecret: SECRET,
    unsubscribe: (id) => (calls.push(id), Promise.resolve()),
  });
  const res = await handler(new Request(await unsubscribeLink('https://x/', SECRET, ID), { method: 'POST' }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [ID]);
});
