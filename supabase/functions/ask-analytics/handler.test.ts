// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { FakeLlmProvider, LlmError } from '@qm/providers';
import { createAskHandler, DbError, type ReportRow } from './handler.ts';

const PUBLIC = 'https://app.example.test';
const GOOD = '{"measures": ["visits", "served"], "dimensions": ["weekday"], "days": 28}';
const ROWS: ReportRow[] = [{ dims: { weekday: 2 }, measures: { visits: 9, served: 8 } }];

function setup(opts: { replies?: (string | Error)[]; rows?: ReportRow[] | DbError; reserve?: number | DbError; config?: boolean } = {}) {
  const fake = new FakeLlmProvider(opts.replies ?? [GOOD, 'Tuesdays are busiest.']);
  const log = { reserved: [] as string[], ran: [] as unknown[] };
  const handler = createAskHandler({
    async reserve(_jwt, _org, question) {
      log.reserved.push(question);
      if (opts.reserve instanceof DbError) throw opts.reserve;
      return opts.reserve ?? 7;
    },
    async llmConfig() {
      return opts.config === false ? null : { provider: 'anthropic', model: 'm', apiKey: 'sk-secret' };
    },
    async runReport(_jwt, definition, from, to) {
      log.ran.push({ definition, from, to });
      if (opts.rows instanceof DbError) throw opts.rows;
      return opts.rows ?? ROWS;
    },
    makeProvider: () => fake,
    today: () => '2026-03-31',
    publicUrl: PUBLIC,
  });
  return { handler, fake, log };
}
const post = (body: unknown, auth: string | null = 'Bearer jwt') =>
  new Request('https://x.test/ask-analytics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC, ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const ask = { org_id: 'org-1', location_id: 'loc-1', question: 'Why was Tuesday slow?' };

Deno.test('answers with a validated definition, the rows and a summary', async () => {
  const { handler, log } = setup();
  const res = await handler(post(ask));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.definition, { measures: ['visits', 'served'], dimensions: ['weekday'], from: '2026-03-04', to: '2026-03-31' });
  assert.deepEqual(body.rows, ROWS);
  assert.equal(body.summary, 'Tuesdays are busiest.');
  assert.equal(body.remaining, 7);
  assert.deepEqual(log.ran[0], {
    definition: { org_id: 'org-1', measures: ['visits', 'served'], dimensions: ['weekday'], filters: { location_id: 'loc-1' } },
    from: '2026-03-04',
    to: '2026-03-31',
  });
});

Deno.test('AC1: a reply that is not a valid definition runs nothing', async () => {
  for (const reply of ['I cannot help', '{"measures": ["revenue"], "dimensions": [], "days": 7}', '{"measures": ["visits"], "dimensions": ["guest_name"], "days": 7}', '{"measures": ["visits; drop table x"], "days": 7}', '{"measures": ["visits"], "days": 9999}', '{"error": "cannot_answer"}']) {
    const { handler, log, fake } = setup({ replies: [reply] });
    const res = await handler(post(ask));
    assert.equal(res.status, 422, reply);
    assert.deepEqual(await res.json(), { error: 'couldnt_answer' });
    assert.equal(log.ran.length, 0, 'nothing ran');
    assert.equal(fake.requests.length, 1, 'no summary call either');
  }
});

Deno.test('AC2: the model is sent the catalogue and the question, then only aggregates', async () => {
  const { handler, fake } = setup();
  await handler(post(ask));
  const [first, second] = fake.requests;
  assert.equal(first!.user, ask.question);
  assert.ok(first!.system.includes('avg_wait_min'));
  assert.ok(!/guest|@/i.test(first!.user));
  assert.deepEqual(JSON.parse(second!.user), { question: ask.question, from: '2026-03-04', to: '2026-03-31', rows: ROWS });
  for (const r of fake.requests) assert.ok(!r.system.includes('sk-secret') && !r.user.includes('sk-secret'));
});

Deno.test('AC2: questions that contain contact details are refused before anything is logged or sent', async () => {
  for (const question of ['What about ana@example.com?', 'Visits for 415 555 0132 today', 'Phone +1 (415) 555-0132']) {
    const { handler, log, fake } = setup();
    const res = await handler(post({ ...ask, question }));
    assert.equal(res.status, 400, question);
    assert.equal(log.reserved.length, 0);
    assert.equal(fake.requests.length, 0);
  }
});

Deno.test('AC3: the database refusing the caller (another org) stops the call and the summary', async () => {
  const { handler, fake } = setup({ rows: new DbError('not_found') });
  const res = await handler(post(ask));
  assert.equal(res.status, 404);
  assert.equal(fake.requests.length, 1);
});

Deno.test('maps database refusals from the reservation and never calls the model', async () => {
  for (const [code, status] of [['analytics_disabled', 409], ['rate_limited', 429], ['permission_denied', 403], ['not_found', 404]] as const) {
    const { handler, fake } = setup({ reserve: new DbError(code) });
    const res = await handler(post(ask));
    assert.equal(res.status, status, code);
    assert.equal(fake.requests.length, 0);
  }
});

Deno.test('a disabled channel (no config) is analytics_disabled', async () => {
  const { handler } = setup({ config: false });
  assert.equal((await handler(post(ask))).status, 409);
});

Deno.test('a failed summary still returns the numbers; a failed first call is a 502', async () => {
  const { handler } = setup({ replies: [GOOD, new LlmError('timeout')] });
  const res = await handler(post(ask));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).summary, null);
  const down = setup({ replies: [new LlmError('unavailable')] });
  assert.equal((await down.handler(post(ask))).status, 502);
});

Deno.test('needs a bearer token and the app origin', async () => {
  const { handler } = setup();
  assert.equal((await handler(post(ask, null))).status, 401);
  const other = new Request('https://x.test/', { method: 'POST', headers: { origin: 'https://evil.test', authorization: 'Bearer j' }, body: '{}' });
  assert.equal((await handler(other)).status, 403);
});
