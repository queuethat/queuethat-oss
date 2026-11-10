// 2P-RPT4 (#200): export-data handler with fake dependencies. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createExportHandler, csvCell, TABLES, type ExportDeps, type Row, type Ticket } from './handler.ts';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const EXPORT = '33333333-3333-4333-8333-333333333333';

/** Two orgs' rows in every table, filtered by org the way the real query is. */
function fixture(extra: Row[] = []): { deps: ExportDeps; calls: string[] } {
  const calls: string[] = [];
  const rows = (org: string): Row[] => [
    { id: `${org}-1`, org_id: org, name: `Row, one of ${org}` },
    { id: `${org}-2`, org_id: org, name: '=HYPERLINK("evil")' },
    ...extra.filter((r) => r.org_id === org),
  ];
  const deps: ExportDeps = {
    async ticket(jwt, id) {
      calls.push(`ticket:${jwt}`);
      return id === EXPORT ? { org_id: ORG_A, format: 'csv', expires_at: new Date(Date.now() + 60_000).toISOString() } : null;
    },
    async page(_jwt, table, orgId, after, limit) {
      calls.push(`${table}:${orgId}`);
      return [...rows(ORG_A), ...rows(ORG_B)]
        .filter((r) => r.org_id === orgId && (after === null || String(r.id) > String(after)))
        .slice(0, limit);
    },
  };
  return { deps, calls };
}

function request(body: unknown, headers: Record<string, string> = { authorization: 'Bearer jwt-a' }) {
  return new Request('https://x.test/export-data', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function unzip(res: Response) {
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, strFromU8(bytes)]));
}

Deno.test('AC1: one file per table with the caller org rows and no other org rows', async () => {
  const { deps, calls } = fixture();
  const res = await createExportHandler(deps)(request({ export_id: EXPORT }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const files = await unzip(res);
  for (const t of TABLES) assert.ok(`${t.name}.csv` in files, `${t.name}.csv is in the zip`);
  assert.ok('README.txt' in files);
  assert.ok(calls.filter((c) => !c.startsWith('ticket')).every((c) => c.endsWith(`:${ORG_A}`)));
  assert.ok(files['queues.csv'].includes(`${ORG_A}-1`));
  assert.ok(!Object.values(files).some((f) => f.includes(ORG_B)));
  assert.ok(files['README.txt'].includes('queues: 2 rows'));
});

Deno.test('CSV cells are quoted and formulas are defused', async () => {
  const { deps } = fixture();
  const files = await unzip(await createExportHandler(deps)(request({ export_id: EXPORT })));
  const lines = files['queues.csv'].split('\r\n');
  assert.equal(lines[0], 'id,org_id,name');
  assert.equal(lines[1], `${ORG_A}-1,${ORG_A},"Row, one of ${ORG_A}"`);
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

Deno.test('pages through more rows than one page holds', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: `${ORG_A}-x${String(i).padStart(5, '0')}`, org_id: ORG_A, name: 'n' }));
  const { deps } = fixture(many);
  const files = await unzip(await createExportHandler(deps)(request({ export_id: EXPORT })));
  assert.equal(files['queues.csv'].trim().split('\r\n').length, 1 + 2 + 2500);
});

Deno.test('JSON Lines tickets give one object per line', async () => {
  const { deps } = fixture();
  const jsonl: ExportDeps = { ...deps, ticket: async () => ({ org_id: ORG_A, format: 'jsonl', expires_at: new Date(Date.now() + 1000).toISOString() } as Ticket) };
  const files = await unzip(await createExportHandler(jsonl)(request({ export_id: EXPORT })));
  const lines = files['queues.jsonl'].trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).org_id, ORG_A);
});

Deno.test('requests without a token, a valid id, or a ticket of the caller are refused', async () => {
  const { deps } = fixture();
  const handler = createExportHandler(deps);
  assert.equal((await handler(request({ export_id: EXPORT }, {}))).status, 401);
  assert.equal((await handler(request({ export_id: 'nope' }))).status, 400);
  assert.equal((await handler(request({ export_id: '44444444-4444-4444-8444-444444444444' }))).status, 404);
  assert.equal((await handler(new Request('https://x.test', { method: 'GET' }))).status, 405);
});

Deno.test('an expired ticket is refused', async () => {
  const { deps } = fixture();
  const expired: ExportDeps = { ...deps, ticket: async () => ({ org_id: ORG_A, format: 'csv', expires_at: '2020-01-01T00:00:00Z' }) };
  assert.equal((await createExportHandler(expired)(request({ export_id: EXPORT }))).status, 410);
});

Deno.test('a failing read is logged without row values and breaks the stream', async () => {
  const { deps } = fixture();
  const logged: string[] = [];
  const broken: ExportDeps = {
    ...deps,
    page: async () => { throw new Error('boom'); },
    log: (line) => logged.push(line),
  };
  const res = await createExportHandler(broken)(request({ export_id: EXPORT }));
  await assert.rejects(res.arrayBuffer());
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes(ORG_A));
});
