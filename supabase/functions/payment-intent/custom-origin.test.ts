// The shared origin gate (_shared/custom-origin.ts), tested here with payment-intent. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createOriginGate } from '../_shared/custom-origin.ts';

function gate(over: Partial<Parameters<typeof createOriginGate>[0]> = {}) {
  const log = { lookups: [] as string[], hits: [] as string[], clock: 0 };
  const g = createOriginGate({
    appOrigin: 'https://app.test',
    isCustomDomain: async (h) => {
      log.lookups.push(h);
      return h === 'book.shop.test';
    },
    hit: async (key) => {
      log.hits.push(key);
      return true;
    },
    bucket: 'b',
    limit: 60,
    windowSeconds: 600,
    now: () => log.clock,
    ...over,
  });
  return { g, log, net: () => Promise.resolve('net1') };
}

Deno.test('the app origin is allowed with no lookup and no rate-limit hit', async () => {
  const { g, log, net } = gate();
  assert.equal(await g('https://app.test', net), true);
  assert.deepEqual([log.lookups, log.hits], [[], []]);
});

Deno.test('a verified host is allowed, remembered for a minute, then asked again', async () => {
  const { g, log, net } = gate();
  assert.equal(await g('https://book.shop.test', net), true);
  assert.equal(await g('https://book.shop.test', net), true);
  assert.equal(log.lookups.length, 1);
  log.clock = 61_000;
  assert.equal(await g('https://book.shop.test', net), true);
  assert.equal(log.lookups.length, 2);
});

Deno.test('not an origin: http, a port, a path, garbage and a verified-looking suffix are refused without a lookup', async () => {
  const { g, log, net } = gate();
  for (const o of ['http://book.shop.test', 'https://book.shop.test:8443', 'https://book.shop.test/x', 'null', 'nonsense']) {
    assert.equal(await g(o, net), false, o);
  }
  assert.deepEqual(log.lookups, []);
  assert.equal(await g('https://evil-book.shop.test', net), false);
});

Deno.test('a refusal is not cached; over the limit refuses before asking the database', async () => {
  const a = gate();
  assert.equal(await a.g('https://other.test', a.net), false);
  assert.equal(await a.g('https://other.test', a.net), false);
  assert.equal(a.log.lookups.length, 2);
  const b = gate({ hit: async () => false });
  assert.equal(await b.g('https://book.shop.test', b.net), false);
  assert.deepEqual(b.log.lookups, []);
});

Deno.test('without a lookup only the app origin is allowed; a failing lookup refuses and is reported', async () => {
  const { g } = gate({ isCustomDomain: undefined });
  assert.equal(await g('https://book.shop.test', () => Promise.resolve('n')), false);
  const errors: string[] = [];
  const { g: g2 } = gate({ isCustomDomain: () => Promise.reject(new Error('x')), error: (l) => errors.push(l) });
  assert.equal(await g2('https://book.shop.test', () => Promise.resolve('n')), false);
  assert.deepEqual(errors, ['b custom domain check failed']);
});

Deno.test('a failing limiter or address hash refuses instead of throwing', async () => {
  const a = gate({ hit: () => Promise.reject(new Error('db down')) });
  assert.equal(await a.g('https://book.shop.test', a.net), false);
  const b = gate();
  assert.equal(await b.g('https://book.shop.test', () => Promise.reject(new Error('digest'))), false);
  assert.deepEqual(b.log.lookups, []);
});
