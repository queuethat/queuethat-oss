import assert from 'node:assert/strict';
import { twilioPlatformHandler, type PlatformSmsEvent } from './twilio-platform.ts';
import type { WebhookContext } from '../handler.ts';

const runWithReply = async (fields: Record<string, string>, isDuplicate = false) => {
  const seen: Parameters<PlatformSmsEvent>[0][] = [];
  const handler = twilioPlatformHandler((e) => { seen.push(e); return Promise.resolve(); });
  const reply = await handler({ provider: 'twilio-platform', orgId: null, eventId: 1, eventKey: 'k', isDuplicate, rawBody: new Uint8Array(), form: new URLSearchParams(fields) } as WebhookContext);
  return { seen, reply };
};
const run = async (fields: Record<string, string>) => (await runWithReply(fields)).seen;

Deno.test('a delivery report becomes a status event with a twilio_ error code', async () => {
  assert.deepEqual(await run({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' }),
    [{ kind: 'status', providerMessageId: 'SM1', status: 'undelivered', errorCode: 'twilio_30003' }]);
  assert.deepEqual(await run({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
    [{ kind: 'status', providerMessageId: 'SM1', status: 'delivered' }]);
});

Deno.test('Advanced Opt-Out STOP and START apply to the sender; HELP and ordinary texts do nothing', async () => {
  assert.deepEqual(await run({ From: '+14155550142', Body: 'STOP', OptOutType: 'STOP' }), [{ kind: 'stop', phone: '+14155550142' }]);
  assert.deepEqual(await run({ From: '+14155550142', Body: 'start', OptOutType: 'start' }), [{ kind: 'start', phone: '+14155550142' }]);
  assert.deepEqual(await run({ From: '+14155550142', Body: 'HELP', OptOutType: 'HELP' }), []);
  assert.deepEqual(await run({ From: '+14155550142', Body: 'L' }), []);
  assert.equal((await runWithReply({ From: '+14155550142', Body: 'STOP', OptOutType: 'STOP' })).reply, undefined, 'Twilio confirms its own keywords');
});

Deno.test('a whole-message YES confirms the sender, with or without Twilio calling it a START', async () => {
  assert.deepEqual(await run({ From: '+14155550142', Body: ' Yes! ' }), [{ kind: 'confirm', phone: '+14155550142' }]);
  assert.deepEqual(await run({ From: '+14155550142', Body: 'YES', OptOutType: 'START' }),
    [{ kind: 'start', phone: '+14155550142' }, { kind: 'confirm', phone: '+14155550142' }]);
  assert.deepEqual(await run({ From: '+14155550142', Body: 'yes please stop' }), []);
});

Deno.test('a free-text opt-out Twilio did not flag is a STOP, answered with a confirmation', async () => {
  for (const body of ['Stop texting me', 'please stop', 'Remove me!', 'unsubscribe me', 'STOP']) {
    const { seen, reply } = await runWithReply({ From: '+14155550142', Body: body });
    assert.deepEqual(seen, [{ kind: 'stop', phone: '+14155550142' }], body);
    assert.match(reply?.body ?? '', /<Message>QueueThat: You have been unsubscribed/, body);
    assert.equal(reply?.contentType, 'text/xml');
  }
  const es = await runWithReply({ From: '+14155550142', Body: 'No más' });
  assert.deepEqual(es.seen, [{ kind: 'stop', phone: '+14155550142' }]);
  assert.match(es.reply?.body ?? '', /Te dimos de baja/);
});

Deno.test('ordinary text, a bare no and phrases inside longer text never opt anyone out', async () => {
  for (const body of ['no', 'No!', 'stop by at 5', 'can you remove me from the 3pm slot', 'L', 'C', 'hello', 'yes please stop']) {
    const { seen, reply } = await runWithReply({ From: '+14155550142', Body: body });
    assert.deepEqual(seen.filter((e) => e.kind === 'stop'), [], body);
    assert.equal(reply, undefined, body);
  }
});

Deno.test('a replayed request is answered again but never applied again', async () => {
  const stop = await runWithReply({ From: '+14155550142', Body: 'remove me' }, true);
  assert.deepEqual(stop.seen, []);
  assert.match(stop.reply?.body ?? '', /unsubscribed/);
  for (const f of <Record<string, string>[]>[{ OptOutType: 'STOP', Body: 'STOP' }, { OptOutType: 'START', Body: 'START' }, { Body: 'YES' }, { MessageSid: 'SM1', MessageStatus: 'delivered' }]) {
    const r = await runWithReply({ From: '+14155550142', ...f }, true);
    assert.deepEqual(r.seen, [], JSON.stringify(f));
    assert.equal(r.reply, undefined);
  }
});

Deno.test('a plain START after a free-text stop lifts it, since Twilio never flagged it', async () => {
  assert.deepEqual(await run({ From: '+14155550142', Body: 'start' }), [{ kind: 'start', phone: '+14155550142' }]);
  assert.deepEqual(await run({ From: '+14155550142', Body: 'Unstop' }), [{ kind: 'start', phone: '+14155550142' }]);
});
