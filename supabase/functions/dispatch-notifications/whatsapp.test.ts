// #930: the dispatcher tells the WhatsApp channel whether to send free text or the approved template.
import assert from 'node:assert/strict';
import { createRegistry, defineChannel, type OutboundMessage } from '@qm/providers';
import { dispatch, type OutboxJob, type WhatsAppSend } from './handler.ts';

function run(send: WhatsAppSend | null | undefined) {
  const sent: OutboundMessage[] = [];
  const reports: unknown[] = [];
  const channel = defineChannel({
    kind: 'whatsapp',
    providerName: 'whatsapp-cloud',
    deliver(msg) {
      sent.push(msg);
      return Promise.resolve({ status: 'sent' as const, providerMessageId: 'wamid' });
    },
  });
  let claimed = false;
  const job = {
    id: 'w1', org_id: 'org-1', visit_id: 'v1', channel: 'whatsapp', category: 'transactional',
    template_key: 'called', template_version: 1, locale: 'en', subject: null,
    body: 'Hi {{guest_first_name}}, {{ticket}} is called at {{counter}}.',
    vars: { guest_first_name: 'Gina', ticket: 'A001' }, recipient: { kind: 'address', value: '+14155550142' },
    has_consent: true, is_suppressed: false, location_tz: 'UTC', attempts: 0, status_url: null,
  } as unknown as OutboxJob;
  return dispatch({
    reserve: () => Promise.resolve('allowed'),
    claim: () => Promise.resolve(claimed ? [] : ((claimed = true), [job])),
    stillRelevant: () => Promise.resolve(true),
    report: (_id, r) => (reports.push(r), Promise.resolve()),
    whatsapp: send === undefined ? undefined : () => Promise.resolve(send),
    registry: createRegistry([channel]),
    secret: 'x'.repeat(32),
    log: () => {},
  }).then(() => ({ sent, reports }));
}

Deno.test('outside the window the approved template goes out with the message values as parameters', async () => {
  const { sent, reports } = await run({ mode: 'template', wa_name: 'turn_called', wa_language: 'en_US', window_open: false });
  assert.deepEqual(sent[0]?.whatsapp, {
    windowOpen: false,
    template: { name: 'turn_called', language: 'en_US', params: ['Gina', 'A001', 'the counter'] },
  });
  assert.equal((reports[0] as { status: string }).status, 'sent');
});

Deno.test('inside the window free text goes out, no template', async () => {
  const { sent } = await run({ mode: 'session', wa_name: null, wa_language: null, window_open: true });
  assert.deepEqual(sent[0]?.whatsapp, { windowOpen: true });
});

Deno.test('template mode without an approved mapping dies, and nothing is sent as free text', async () => {
  const { sent, reports } = await run({ mode: 'template', wa_name: null, wa_language: null, window_open: false });
  assert.equal(sent.length, 0);
  assert.deepEqual(reports[0], { status: 'failed', retryable: false, error_code: 'no_approved_template' });
});

Deno.test('a row no longer allowed (mode null) is suppressed, not sent', async () => {
  const { sent, reports } = await run({ mode: null, wa_name: null, wa_language: null, window_open: false });
  assert.equal(sent.length, 0);
  assert.deepEqual(reports[0], { status: 'suppressed', error_code: 'not_relevant' });
});
