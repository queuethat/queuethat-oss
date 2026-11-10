import assert from 'node:assert/strict';
import { createTwilioVoiceHandler, type VoiceCall, type VoiceResult, voiceTwiml } from './twilio-voice.ts';

const SELF = 'https://x.test/functions/v1/provider-webhook/twilio-voice/e1';
const ctx = (params: Record<string, string>, query = '', orgId: string | null = 'org-a') => ({
  provider: 'twilio-voice', orgId, eventId: 1, eventKey: 'k', rawBody: new Uint8Array(),
  form: new URLSearchParams(params), query: new URLSearchParams(query), selfUrl: SELF,
});

Deno.test('the first request asks the database for the menu and gathers one keypress', async () => {
  const seen: VoiceCall[] = [];
  const handle = createTwilioVoiceHandler(async (c) => {
    seen.push(c);
    return { handled: 'menu', location: 'Demo Barber', queues: ['Walk-ins'] } as VoiceResult;
  });
  const reply = await handle(ctx({ CallSid: 'CA1', From: '+14155550123' }));
  assert.equal(seen[0].step, 'menu');
  assert.equal(seen[0].verified, false);
  assert.match(reply!.body, /Welcome to Demo Barber/);
  assert.match(reply!.body, /<Gather [^>]*action="[^"]*\?step=join"/);
  assert.equal(reply!.contentType, 'text/xml');
});

Deno.test('a keypress at the join step carries the digit; the step comes from the signed query', async () => {
  const seen: VoiceCall[] = [];
  const handle = createTwilioVoiceHandler(async (c) => {
    seen.push(c);
    return { handled: 'joined', ticket: 'A012', position: 3, eta_low: 8, eta_high: 14, offer_text: false } as VoiceResult;
  });
  const reply = await handle(ctx({ CallSid: 'CA1', From: '+14155550123', Digits: '1', StirVerstat: 'TN-Validation-Passed-A' }, 'step=join'));
  assert.deepEqual([seen[0].step, seen[0].digits, seen[0].verified], ['join', '1', true]);
  assert.match(reply!.body, /A012/);
  assert.match(reply!.body, /8 to 14 minutes/);
  assert.doesNotMatch(reply!.body, /Gather/, 'no text offer when the database does not offer one');
});

Deno.test('the text offer reads the consent and gathers one more keypress for this visit', () => {
  const twiml = voiceTwiml({ handled: 'joined', ticket: 'A012', position: 1, offer_text: true, visit_id: 'v&1' }, SELF);
  assert.match(twiml, /Message and data rates may apply/);
  assert.match(twiml, /step=consent&amp;visit=v%261/);
});

Deno.test('only a fully attested caller ID counts as verified', async () => {
  const seen: boolean[] = [];
  const handle = createTwilioVoiceHandler(async (c) => { seen.push(c.verified); return { handled: 'bye' } as VoiceResult; });
  for (const v of ['TN-Validation-Passed-A', 'TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'TN-Validation-Failed-A', '']) {
    await handle(ctx({ CallSid: 'CA1', From: '+1', StirVerstat: v }));
  }
  assert.deepEqual(seen, [true, false, false, false, false]);
});

Deno.test('text from the database is escaped in the TwiML', () => {
  const twiml = voiceTwiml({ handled: 'menu', location: 'A & <B>', queues: ['x"y'] }, SELF);
  assert.match(twiml, /A &amp; &lt;B&gt;/);
  assert.doesNotMatch(twiml, /<B>/);
});

Deno.test('closed and invalid answers hang up or return to the menu', () => {
  assert.match(voiceTwiml({ handled: 'closed' }, SELF), /not taking new people[\s\S]*<Hangup\/>/);
  assert.match(voiceTwiml({ handled: 'invalid' }, SELF), /<Redirect[^>]*>[^<]*step=menu/);
});

Deno.test('an endpoint without an org gets the failure TwiML, not an error', async () => {
  const handle = createTwilioVoiceHandler(async () => { throw new Error('unreachable'); });
  const reply = await handle(ctx({ CallSid: 'CA1' }, '', null));
  assert.match(reply!.body, /something went wrong/);
});
