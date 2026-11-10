// 3-EM2 (#348): Resend (Svix) and Postmark webhooks. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import complained from '../../../../tests/fixtures/webhooks/email/resend-complained.json' with { type: 'json' };
import bounced from '../../../../tests/fixtures/webhooks/email/resend-bounced.json' with { type: 'json' };
import pmBounce from '../../../../tests/fixtures/webhooks/email/postmark-bounce.json' with { type: 'json' };
import pmSoft from '../../../../tests/fixtures/webhooks/email/postmark-soft.json' with { type: 'json' };
import { createProviderWebhookHandler } from '../handler.ts';
import { postmarkHandler, resendHandler } from './email.ts';

const A = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';
const NOW = 1_800_000_000;
const SVIX_KEY = Buffer.from('svix-signing-key-bytes').toString('base64');
const SVIX_SECRET = `whsec_${SVIX_KEY}`;
const PM_SECRET = 'hook:s3cret';

function setup(secret: string) {
  const writes = { status: [] as unknown[][], suppress: [] as unknown[][], records: 0 };
  const apply = async (...a: unknown[]) => { writes.status.push(a); return true; };
  const suppress = async (...a: unknown[]) => { writes.suppress.push(a); return true; };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    now: () => new Date(NOW * 1000),
    endpointSecrets: async (_p, id) => (id === A ? { orgId: 'org-a', secrets: [secret] } : null),
    record: async () => { writes.records++; return { eventId: writes.records, isDuplicate: false }; },
    markProcessed: async () => {},
    handlers: {
      resend: resendHandler(apply as never, suppress as never),
      postmark: postmarkHandler(apply as never, suppress as never),
    },
  });
  return { handler, writes };
}

function svix(body: unknown, { id = 'msg_1', ts = NOW, key = SVIX_KEY } = {}) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', Buffer.from(key, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  return new Request(`${BASE}/provider-webhook/resend/${A}`, {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,bogus v1,${sig}` },
  });
}
const pm = (body: unknown, auth = 'Basic ' + btoa(PM_SECRET)) =>
  new Request(`${BASE}/provider-webhook/postmark/${A}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: auth },
  });

Deno.test('AC1: a signed Resend complaint suppresses the org\'s own recipient', async () => {
  const { handler, writes } = setup(SVIX_SECRET);
  assert.equal((await handler(svix(complained))).status, 200);
  assert.deepEqual(writes.suppress, [['org-a', 'resend', 'em_1', 'complaint']]);
});

Deno.test('a permanent Resend bounce is failed and suppressed; delivered only updates the status', async () => {
  const { handler, writes } = setup(SVIX_SECRET);
  await handler(svix(bounced, { id: 'msg_2' }));
  assert.deepEqual(writes.suppress, [['org-a', 'resend', 'em_2', 'bounce']]);
  assert.deepEqual(writes.status, [['org-a', 'resend', 'em_2', 'failed', 'resend_bounce']]);
  const d = setup(SVIX_SECRET);
  await d.handler(svix({ type: 'email.delivered', data: { email_id: 'em_3' } }, { id: 'msg_3' }));
  assert.deepEqual(d.writes.suppress, []);
  assert.deepEqual(d.writes.status, [['org-a', 'resend', 'em_3', 'delivered', undefined]]);
});

Deno.test('AC2: a bad Svix signature, wrong key or stale timestamp is 403 and writes nothing', async () => {
  for (const req of [
    svix(complained, { key: Buffer.from('other').toString('base64') }),
    svix(complained, { ts: NOW - 301 }),
    new Request(`${BASE}/provider-webhook/resend/${A}`, { method: 'POST', body: JSON.stringify(complained) }),
  ]) {
    const { handler, writes } = setup(SVIX_SECRET);
    assert.equal((await handler(req)).status, 403);
    assert.equal(writes.records + writes.suppress.length + writes.status.length, 0);
  }
  const { handler } = setup(SVIX_SECRET);
  assert.equal((await handler(svix(complained, { ts: NOW - 299 }))).status, 200, 'inside the 5 minute window');
});

Deno.test('the Svix id is the idempotency key, so a changed body cannot reuse it', async () => {
  const { handler, writes } = setup(SVIX_SECRET);
  await handler(svix(complained, { id: 'msg_9' }));
  await handler(svix(bounced, { id: 'msg_10' }));
  assert.equal(writes.records, 2);
});

Deno.test('Postmark: basic auth gates, a hard bounce suppresses, a soft one only marks undelivered', async () => {
  const bad = setup(PM_SECRET);
  assert.equal((await bad.handler(pm(pmBounce, 'Basic ' + btoa('hook:wrong')))).status, 403);
  assert.equal((await bad.handler(pm(pmBounce, ''))).status, 403);
  assert.equal(bad.writes.records, 0);
  const { handler, writes } = setup(PM_SECRET);
  assert.equal((await handler(pm(pmBounce))).status, 200);
  assert.deepEqual(writes.suppress, [['org-a', 'postmark', 'pm_1', 'bounce']]);
  await handler(pm(pmSoft));
  assert.equal(writes.suppress.length, 1);
  assert.deepEqual(writes.status.at(-1), ['org-a', 'postmark', 'pm_2', 'undelivered', 'postmark_bounce_soft']);
  await handler(pm({ RecordType: 'SpamComplaint', MessageID: 'pm_3' }));
  assert.deepEqual(writes.suppress.at(-1), ['org-a', 'postmark', 'pm_3', 'complaint']);
});

Deno.test('the org comes from the endpoint: an unknown endpoint id is 403', async () => {
  const { handler } = setup(PM_SECRET);
  const req = new Request(`${BASE}/provider-webhook/postmark/0a1b2c3d-8d5a-4c55-9a1e-2b9f3c4d5e6f`, {
    method: 'POST', body: '{}', headers: { authorization: 'Basic ' + btoa(PM_SECRET) },
  });
  assert.equal((await handler(req)).status, 403);
});
