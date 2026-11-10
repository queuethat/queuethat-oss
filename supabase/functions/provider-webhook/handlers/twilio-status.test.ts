// 3-SMS2 (#351): Twilio status callbacks. Run with `pnpm test:functions`.
import assert from 'node:assert/strict';
import { twilioStatusHandler } from './twilio-status.ts';

function run(params: Record<string, string>, orgId: string | null = 'org-a') {
  const calls: unknown[][] = [];
  const handler = twilioStatusHandler(async (...args) => { calls.push(args); return true; });
  const done = handler({
    provider: 'twilio', orgId, eventId: 1, eventKey: 'k', rawBody: new Uint8Array(),
    form: new URLSearchParams(params),
  });
  return { calls, done };
}

Deno.test('delivered and undelivered callbacks are applied for the endpoint org', async () => {
  const d = run({ MessageSid: 'SM1', MessageStatus: 'delivered' });
  await d.done;
  assert.deepEqual(d.calls, [['org-a', 'twilio', 'SM1', 'delivered', undefined]]);
  const u = run({ MessageSid: 'SM2', MessageStatus: 'undelivered', ErrorCode: '30003', AccountSid: 'ACother' });
  await u.done;
  assert.deepEqual(u.calls, [['org-a', 'twilio', 'SM2', 'undelivered', 'twilio_30003']]);
});

Deno.test('inbound messages, unknown statuses and a missing org change nothing', async () => {
  for (const [params, org] of [
    [{ MessageSid: 'SM1', Body: 'STOP' }, 'org-a'],
    [{ MessageSid: 'SM1', MessageStatus: 'weird' }, 'org-a'],
    [{ MessageSid: 'SM1', MessageStatus: 'sent' }, null],
  ] as const) {
    const r = run({ ...params }, org);
    await r.done;
    assert.equal(r.calls.length, 0);
  }
});
