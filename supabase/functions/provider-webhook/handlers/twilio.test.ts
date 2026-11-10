import assert from 'node:assert/strict';
import { createTwilioInboundHandler, type InboundMessage } from './twilio.ts';

const ctx = (params: Record<string, string>, orgId: string | null = 'org-a') => ({
  provider: 'twilio', orgId, eventId: 1, eventKey: 'k', rawBody: new Uint8Array(), form: new URLSearchParams(params),
});

Deno.test('an inbound text is passed to process_inbound_message for the endpoint org', async () => {
  const seen: InboundMessage[] = [];
  const handle = createTwilioInboundHandler(async (m) => { seen.push(m); });
  await handle(ctx({ Body: 'STOP', From: '+14155550123', To: '+14155550000', MessageSid: 'SM1' }));
  assert.deepEqual(seen, [{ orgId: 'org-a', channel: 'sms', from: '+14155550123', to: '+14155550000', body: 'STOP', provider: 'twilio', providerMessageId: 'SM1' }]);
});

Deno.test('status callbacks and endpoints without an org are not texts', async () => {
  const seen: InboundMessage[] = [];
  const handle = createTwilioInboundHandler(async (m) => { seen.push(m); });
  await handle(ctx({ MessageSid: 'SM1', MessageStatus: 'delivered' }));
  await handle(ctx({ Body: 'hi', From: '+14155550123' }, null));
  assert.equal(seen.length, 0);
});
