import assert from 'node:assert/strict';
import { createMetaHandler } from './meta.ts';
import type { InboundMessage } from './twilio.ts';
import inboundText from '../../../../tests/fixtures/webhooks/meta/inbound-text.json' with { type: 'json' };
import statuses from '../../../../tests/fixtures/webhooks/meta/status-delivered.json' with { type: 'json' };

function harness(phoneNumberId: string | null = '1055') {
  const inbound: InboundMessage[] = [];
  const receipts: unknown[][] = [];
  const handle = createMetaHandler({
    processInbound: async (m) => { inbound.push(m); },
    applyStatus: async (...args) => { receipts.push(args); return true; },
    phoneNumberId: async () => phoneNumberId,
  });
  const run = (fixture: unknown, eventKey: string, orgId: string | null = 'org-a') =>
    handle({ provider: 'meta', orgId, eventId: 1, eventKey, rawBody: new TextEncoder().encode(JSON.stringify(fixture)) });
  return { inbound, receipts, run };
}

Deno.test('an inbound text goes to process_inbound_message as whatsapp for the endpoint org', async () => {
  const h = harness();
  await h.run(inboundText, 'wamid.IN1');
  assert.deepEqual(h.inbound, [{
    orgId: 'org-a', channel: 'whatsapp', from: '+14155550123', to: '+15550001111', body: 'STOP',
    provider: 'meta', providerMessageId: 'wamid.IN1',
  }]);
});

Deno.test('only the message named by the event key is processed; media is skipped', async () => {
  const h = harness();
  await h.run(inboundText, 'wamid.IN2');
  assert.equal(h.inbound.length, 0);
});

Deno.test('AC3: a phone_number_id that is not the endpoint org\'s writes nothing', async () => {
  const h = harness('9999');
  await h.run(inboundText, 'wamid.IN1');
  await h.run(statuses, 'wamid.OUT1:delivered');
  assert.equal(h.inbound.length + h.receipts.length, 0);
  const none = harness(null);
  await none.run(inboundText, 'wamid.IN1');
  assert.equal(none.inbound.length, 0);
});

Deno.test('receipts are mapped and applied for the endpoint org', async () => {
  const h = harness();
  await h.run(statuses, 'wamid.OUT1:delivered');
  await h.run(statuses, 'wamid.OUT2:failed');
  await h.run(statuses, 'wamid.OUT3:sent');
  assert.deepEqual(h.receipts, [
    ['org-a', 'meta', 'wamid.OUT1', 'delivered', undefined],
    ['org-a', 'meta', 'wamid.OUT2', 'failed', 'whatsapp_131026'],
    ['org-a', 'meta', 'wamid.OUT3', 'sent', undefined],
  ]);
});

Deno.test('an endpoint without an org, or a body that is not JSON, does nothing', async () => {
  const h = harness();
  await h.run(inboundText, 'wamid.IN1', null);
  assert.equal(h.inbound.length, 0);
  await createMetaHandler({ processInbound: async () => { throw new Error('no'); }, applyStatus: async () => true, phoneNumberId: async () => '1055' })(
    { provider: 'meta', orgId: 'org-a', eventId: 1, eventKey: 'x', rawBody: new TextEncoder().encode('nope') });
});
