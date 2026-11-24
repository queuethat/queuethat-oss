// postPinned against a local HTTP server: it connects to the given address and reads the status.
import assert from 'node:assert/strict';
import { postPinned } from './pinned-post.ts';

Deno.test('postPinned connects to the pinned address and ignores what DNS would say', async () => {
  const seen: { host: string | null; body: string; sig: string | null }[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (req) => {
    seen.push({ host: req.headers.get('host'), body: await req.text(), sig: req.headers.get('x-qm-signature') });
    return new Response('ok', { status: 202 });
  });
  const port = server.addr.port;
  try {
    // "webhooks.invalid" never resolves: only the pinned address can make this succeed.
    const res = await postPinned(`http://webhooks.invalid:${port}/in?x=1`, { 'X-QM-Signature': 't=1,v1=ab' }, '{"a":1}', 5000, '127.0.0.1');
    assert.equal(res.status, 202);
    assert.deepEqual(seen, [{ host: `webhooks.invalid:${port}`, body: '{"a":1}', sig: 't=1,v1=ab' }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test('postPinned refuses header injection and times out on a silent server', async () => {
  await assert.rejects(() => postPinned('http://x.invalid/', { 'X-A': 'a\r\nB: c' }, '{}', 1000, '127.0.0.1'), /bad_header/);
  const silent = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (silent.addr as Deno.NetAddr).port;
  const accepted = silent.accept().catch(() => undefined);
  try {
    await assert.rejects(() => postPinned(`http://x.invalid:${port}/`, {}, '{}', 300, '127.0.0.1'));
  } finally {
    silent.close();
    (await accepted)?.close();
  }
});
