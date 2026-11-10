// 2B-I7 (#312): deliver-webhooks with fake network and database. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { verifyWebhook } from '../../../packages/domain/src/webhook-signature.ts';
import {
  createDeliverHandler,
  type DeliverDeps,
  isBlockedAddress,
  type WebhookJob,
  type WebhookReport,
} from './handler.ts';

const KEY = 'dispatch-secret-0123456789abcdef0123';

function job(overrides: Partial<WebhookJob> = {}): WebhookJob {
  return {
    delivery_id: 'd1', url: 'https://hooks.example.com/in', kind: 'generic', event_type: 'visit.called',
    payload: { id: 'v:1', type: 'visit.called' }, secret: 'whsec_one', attempt: 0, ...overrides,
  };
}

function setup(jobs: WebhookJob[], statuses: number[], opts: Partial<DeliverDeps> = {}) {
  const reports: [string, WebhookReport][] = [];
  const sent: { headers: Record<string, string>; body: string }[] = [];
  let n = 0;
  const deps: DeliverDeps = {
    claim: async () => jobs,
    report: async (id, r) => { reports.push([id, r]); },
    resolve: async () => ['93.184.216.34'],
    post: async (_url, headers, body) => {
      sent.push({ headers, body });
      return { status: statuses[Math.min(n++, statuses.length - 1)]! };
    },
    secret: KEY, allowPrivate: false, now: () => 1_700_000_000, log: () => {}, ...opts,
  };
  const handle = createDeliverHandler(deps);
  const call = (auth = `Bearer ${KEY}`, method = 'POST') =>
    handle(new Request('http://x/', { method, headers: { Authorization: auth } }));
  return { call, reports, sent };
}

Deno.test('rejects anything but POST with the secret', async () => {
  const { call } = setup([], [200]);
  assert.equal((await call('Bearer nope')).status, 401);
  assert.equal((await call(`Bearer ${KEY}`, 'GET')).status, 405);
});

Deno.test('AC1: 500 twice then 200 is delivered on attempt 3 with the same event id', async () => {
  const ids: string[] = [];
  for (const attempt of [0, 1, 2]) {
    const { call, reports, sent } = setup([job({ attempt })], [attempt < 2 ? 500 : 200]);
    await call();
    ids.push(sent[0]!.headers['X-QM-Event-Id']!);
    assert.equal(reports[0]![1].status, attempt < 2 ? 'failed' : 'delivered');
    if (attempt < 2) assert.equal(reports[0]![1].retry_in_seconds, [60, 300][attempt]);
  }
  assert.deepEqual(ids, ['v:1', 'v:1', 'v:1']);
});

Deno.test('AC2: private and metadata addresses are refused without a request', async () => {
  for (const ip of ['169.254.169.254', '10.0.0.5', '127.0.0.1', '::1', '::ffff:10.0.0.1', 'fd00::1', '2002:7f00:1::', '::7f00:1', 'fec0::1', '203.0.113.9']) {
    const { call, reports, sent } = setup([job()], [200], { resolve: async () => [ip] });
    await call();
    assert.equal(sent.length, 0, ip);
    assert.equal(reports[0]![1].error, 'blocked_address', ip);
  }
  const { call, sent } = setup([job({ url: 'https://10.0.0.5/hook' })], [200], { allowPrivate: true });
  await call();
  assert.equal(sent.length, 1, 'WEBHOOK_ALLOW_PRIVATE lets a LAN self-host through');
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

Deno.test('AC3: the request is signed and verifies; a changed body does not', async () => {
  const { call, sent } = setup([job({ secret: 'whsec_new,whsec_old' })], [200]);
  await call();
  const { headers, body } = sent[0]!;
  assert.equal(await verifyWebhook('whsec_old', body, headers['X-QM-Signature']!, { now: 1_700_000_000 }), true);
  assert.equal(await verifyWebhook('whsec_new', body + ' ', headers['X-QM-Signature']!, { now: 1_700_000_000 }), false);
});

Deno.test('the eighth failure and a 410 are dead; chat kinds only reach their vendor host', async () => {
  const { call, reports } = setup([job({ attempt: 7 })], [500]);
  assert.equal(((await (await call()).json()) as { dead: number }).dead, 1);
  assert.equal(reports[0]![1].retryable, true);
  const gone = setup([job()], [410]);
  assert.equal(((await (await gone.call()).json()) as { dead: number }).dead, 1);
  const chat = setup([job({ kind: 'slack', url: 'https://evil.example.com/x' })], [200]);
  await chat.call();
  assert.equal(chat.reports[0]![1].error, 'blocked_host');
  assert.equal(chat.reports[0]![1].retryable, false, 'a refused URL is not retried');
  const plain = setup([job({ kind: 'slack', url: 'http://hooks.slack.com/x' })], [200]);
  await plain.call();
  assert.equal(plain.reports[0]![1].error, 'blocked_host');
  for (const url of ['https://localhost/x', 'https://printer.local/x', 'https://db.internal/x']) {
    const t = setup([job({ url })], [200]);
    await t.call();
    assert.equal(t.sent.length, 0, url);
  }
});

Deno.test('AC4: two invocations do not send a delivery twice (the claim hands each out once)', async () => {
  const queue = [job()];
  const claim = async () => queue.splice(0);
  const a = setup([], [200], { claim });
  const b = setup([], [200], { claim });
  await Promise.all([a.call(), b.call()]);
  assert.equal(a.sent.length + b.sent.length, 1);
});

Deno.test('AC1 (chat): a slack endpoint gets a Slack body, no HMAC headers and no contact data', async () => {
  const payload = { id: 'v:9', type: 'visit.joined', data: { visit: { ticket: 'A012' }, queue: { name: 'Walk-ins', waiting_count: 3 } } };
  const { call, sent } = setup([job({ kind: 'slack', url: 'https://hooks.slack.com/services/T/B/x', payload })], [200]);
  await call();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers['X-QM-Signature'], undefined);
  const body = JSON.parse(sent[0]!.body);
  assert.ok(body.blocks[0].text.text.includes('A012 joined in Walk-ins'));
  assert.doesNotMatch(sent[0]!.body, /phone|email/i);
});
