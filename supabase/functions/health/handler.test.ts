// O6 (#77). Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { CACHE_MS, createHealthHandler, type HealthReport } from './handler.ts';

const NOW = '2026-10-25T12:00:00Z';
const ago = (seconds: number) => new Date(Date.parse(NOW) - seconds * 1000).toISOString();
const healthy: HealthReport = {
  checked_at: NOW,
  rollover_ok_at: ago(4 * 60),
  dispatcher_kick_ok_at: ago(15),
  oldest_due_at: null,
};

async function check(report: () => Promise<HealthReport>, method = 'GET') {
  const errors: string[] = [];
  const handler = createHealthHandler({ report, error: (line, cause) => void errors.push(`${line}: ${String(cause)}`) });
  const response = await handler(new Request('http://x/health', { method }));
  return { status: response.status, body: await response.json(), response, errors };
}

Deno.test('healthy jobs answer 200 and are never cached', async () => {
  const { status, body, response } = await check(() => Promise.resolve(healthy));
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

Deno.test('a stale or missing job and a stuck send each fail by name', async () => {
  const { status, body } = await check(() =>
    Promise.resolve({
      checked_at: NOW,
      rollover_ok_at: ago(16 * 60),
      dispatcher_kick_ok_at: null,
      oldest_due_at: ago(11 * 60),
    })
  );
  assert.equal(status, 503);
  assert.deepEqual(body, { status: 'failing', failing: ['rollover', 'dispatcher', 'outbox'] });
});

Deno.test('a send that is due but recent is fine', async () => {
  const { status } = await check(() => Promise.resolve({ ...healthy, oldest_due_at: ago(60) }));
  assert.equal(status, 200);
});

Deno.test('an unreadable report is a database failure, reported without detail', async () => {
  const { status, body, errors } = await check(() => Promise.reject(new Error('connection refused')));
  assert.equal(status, 503);
  assert.deepEqual(body, { status: 'failing', failing: ['database'] });
  assert.deepEqual(errors, ['health report failed: Error: connection refused']);
});

Deno.test('only GET and HEAD are answered', async () => {
  const { status } = await check(() => Promise.resolve(healthy), 'POST');
  assert.equal(status, 405);
});

Deno.test('one database read serves every request in the cache window', async () => {
  let reads = 0;
  let clock = 0;
  const handler = createHealthHandler({
    report: () => {
      reads++;
      return Promise.resolve(healthy);
    },
    now: () => clock,
  });
  const get = () => handler(new Request('http://x/health'));
  await Promise.all(Array.from({ length: 50 }, get));
  assert.equal(reads, 1, 'concurrent requests share one read');
  clock = CACHE_MS - 1;
  await get();
  assert.equal(reads, 1);
  clock = CACHE_MS;
  await get();
  assert.equal(reads, 2, 'the next window reads again');
});
