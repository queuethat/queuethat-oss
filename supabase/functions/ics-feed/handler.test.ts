// Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { buildCalendar, createFeedHandler, escapeText, fold, type FeedRow } from './handler.ts';

const TOKEN = 'A'.repeat(43);
const ROW: FeedRow = {
  id: '6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f',
  service_id: 'svc-1',
  starts_at: '2026-12-21T15:00:00+00:00',
  ends_at: '2026-12-21T15:20:00+00:00',
  status: 'booked',
  guest_name: null,
  version: 2,
};

function setup(rows: FeedRow[] | null = [ROW], fail = false) {
  const errors: string[] = [];
  const handler = createFeedHandler({
    events: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(rows)),
    serviceNames: () => Promise.resolve(new Map([['svc-1', 'Haircut, long']])),
    now: () => Date.parse('2026-12-14T12:00:00Z'),
    error: (line) => errors.push(line),
  });
  return { handler, errors };
}
const get = (path: string) => new Request(`https://x/functions/v1/ics-feed/${path}`);

Deno.test('a valid token gets a calendar with stable UIDs and UTC times', async () => {
  const { handler } = setup();
  const res = await handler(get(`${TOKEN}.ics`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/calendar/);
  const body = await res.text();
  assert.match(body, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(body, /UID:appt-6f1c1f0e-8d5a-4c55-9a1e-2b9f3c4d5e6f@queue-management/);
  assert.match(body, /DTSTART:20261221T150000Z/);
  assert.match(body, /DTEND:20261221T152000Z/);
  assert.match(body, /SUMMARY:Haircut\\, long\r\n/);
  assert.match(body, /SEQUENCE:2/);
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
});

Deno.test('the title is the service name only unless the row carries a guest name', async () => {
  const withName = await setup([{ ...ROW, guest_name: 'Cora' }]).handler(get(`${TOKEN}.ics`));
  assert.match(await withName.text(), /SUMMARY:Cora - Haircut\\, long/);
});

Deno.test('an unknown token, a malformed path and a missing extension all give the same 404', async () => {
  const unknown = await setup(null).handler(get(`${TOKEN}.ics`));
  const short = await setup().handler(get('short.ics'));
  const noExt = await setup().handler(get(TOKEN));
  for (const res of [unknown, short, noExt]) {
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'not found');
  }
});

Deno.test('a failing database answers 404 and logs without the token', async () => {
  const { handler, errors } = setup([ROW], true);
  const res = await handler(get(`${TOKEN}.ics`));
  assert.equal(res.status, 404);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0]!.includes(TOKEN));
});

Deno.test('only GET is allowed, and one token is limited to 30 requests a minute', async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request(`https://x/ics-feed/${TOKEN}.ics`, { method: 'POST' }))).status, 405);
  for (let i = 0; i < 30; i++) assert.equal((await handler(get(`${TOKEN}.ics`))).status, 200);
  assert.equal((await handler(get(`${TOKEN}.ics`))).status, 429);
});

Deno.test('text is escaped and long lines fold at 75 octets', () => {
  assert.equal(escapeText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d e');
  assert.equal(escapeText('X\rEND:VEVENT\u2028Y\u0085Z'), 'X END:VEVENT Y Z');
  const folded = fold('X'.repeat(200));
  for (const line of folded.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), 'X'.repeat(200));
  assert.ok(buildCalendar([], new Map(), 0).includes('BEGIN:VCALENDAR'));
});
