// 3-CG14 (#339): the phase 3 compliance gate, Edge Function half, plus the check that the gate document
// covers every criterion. The database half is supabase/tests/compliance/phase3.test.sql.
// Webhooks run against the recorded fixtures in tests/fixtures/webhooks (signed with node:crypto).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProviderWebhookHandler } from '../../supabase/functions/provider-webhook/handler';
import metaFx from '../fixtures/webhooks/meta-event.json';
import stripeFx from '../fixtures/webhooks/stripe-event.json';
import twilioFx from '../fixtures/webhooks/twilio-inbound.json';

const ENDPOINT = '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f';
const BASE = 'https://example.test/functions/v1';

/** A handler over in-memory deps that counts every write the real one would make. */
function harness(secret: string, nowSeconds = stripeFx.t + 10) {
  const seen = new Set<string>();
  const writes = { records: 0, handled: 0, processed: 0 };
  const handler = createProviderWebhookHandler({
    publicFunctionsUrl: BASE,
    now: () => new Date(nowSeconds * 1000),
    endpointSecrets: async () => ({ orgId: 'org-a', secrets: [secret] }),
    record: async (provider, key) => {
      writes.records++;
      const isDuplicate = seen.has(`${provider}:${key}`);
      seen.add(`${provider}:${key}`);
      return { eventId: seen.size, isDuplicate };
    },
    markProcessed: async () => {
      writes.processed++;
    },
    handlers: {
      twilio: async () => void writes.handled++,
      stripe: async () => void writes.handled++,
      meta: async () => void writes.handled++,
    },
  });
  return { handler, writes };
}

const twilio = (params: Record<string, string> = twilioFx.params, signature = twilioFx.signature) =>
  new Request(`${BASE}/provider-webhook/twilio/${ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  });
const stripe = (v1 = stripeFx.v1) =>
  new Request(`${BASE}/provider-webhook/stripe/${ENDPOINT}`, {
    method: 'POST',
    headers: { 'stripe-signature': `t=${stripeFx.t},v1=${v1}` },
    body: stripeFx.body,
  });
const meta = (signature = metaFx.signature) =>
  new Request(`${BASE}/provider-webhook/meta/${ENDPOINT}`, {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: metaFx.body,
  });

describe('CG14-01 webhooks reject bad signatures before any write; replays are no-ops', () => {
  it('rejects an altered Twilio body, a bad Stripe signature and a bad Meta signature with no writes', async () => {
    for (const [secret, req] of [
      [twilioFx.secret, twilio({ ...twilioFx.params, Body: 'START' })],
      [twilioFx.secret, twilio(twilioFx.params, 'AAAA')],
      [stripeFx.secret, stripe('0'.repeat(64))],
      [metaFx.secret, meta('sha256=' + '0'.repeat(64))],
    ] as const) {
      const { handler, writes } = harness(secret);
      expect((await handler(req)).status).toBe(403);
      expect(writes).toEqual({ records: 0, handled: 0, processed: 0 });
    }
  });

  it('rejects a request with no signature header at all', async () => {
    const { handler, writes } = harness(twilioFx.secret);
    const unsigned = new Request(`${BASE}/provider-webhook/twilio/${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    expect((await handler(unsigned)).status).toBe(403);
    expect(writes.records).toBe(0);
  });

  it('rejects a correctly signed Stripe event older than the 300 s tolerance', async () => {
    const { handler, writes } = harness(stripeFx.secret, stripeFx.t + 301);
    const res = await handler(stripe());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'stale' });
    expect(writes.records).toBe(0);
  });

  it('answers a valid Twilio, Stripe and Meta fixture with 200', async () => {
    expect((await harness(twilioFx.secret).handler(twilio())).status).toBe(200);
    expect((await harness(stripeFx.secret).handler(stripe())).status).toBe(200);
    expect((await harness(metaFx.secret).handler(meta())).status).toBe(200);
  });

  it('runs the handler once when the same event arrives three times', async () => {
    for (const [secret, req] of [
      [twilioFx.secret, twilio],
      [stripeFx.secret, stripe],
      [metaFx.secret, meta],
    ] as const) {
      const { handler, writes } = harness(secret);
      for (let i = 0; i < 3; i++) expect((await handler(req())).status).toBe(200);
      const events = writes.records / 3;
      expect(writes.handled).toBe(events);
      expect(writes.processed).toBe(events);
    }
  });
});

describe('the gate document covers section 9 "Phase 3" of compliance.md', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const checklist = read('docs/compliance/security-review.md')
    .split('### Phase 3 (')[1]
    .split('\n## ')[0];
  const criteria = checklist.split('\n').filter((l) => l.startsWith('- [ ]'));
  const gate = read('docs/compliance/phase3-gate.md');
  const rows = gate.split('\n').filter((l) => /^\| G\d+ /.test(l));
  const testIds = (text: string) => new Set(text.match(/CG14-\d\d/g));
  const defined = new Set([
    ...testIds(read('supabase/tests/compliance/phase3.test.sql')),
    ...testIds(readFileSync(new URL(import.meta.url), 'utf8')),
  ]);

  it('has one row per criterion', () => {
    expect(criteria.length).toBeGreaterThan(0);
    expect(rows.length).toBe(criteria.length);
  });

  it('points every row at tests that exist (the hosted-only legal item at 3-CG12)', () => {
    for (const row of rows) {
      const ids = [...testIds(row)];
      if (/\[lawyer\]|3-CG12/.test(row)) expect(row).toContain('3-CG12');
      else expect(ids.length, row).toBeGreaterThan(0);
      for (const id of ids) expect(defined.has(id), `${id} in: ${row}`).toBe(true);
    }
  });

  it('lists every test id the suite defines', () => {
    for (const id of defined) expect(gate, id).toContain(id);
  });
});
