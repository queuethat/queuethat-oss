// Twilio Voice -> api.process_voice_call: join a queue by keypad. The signature is already verified;
// what is left is turning the database's answer into TwiML. All rules (which queues, accepting,
// consent) live in the database; this file only speaks. English only for now: the prompts have no
// translations yet.
import type { WebhookHandler } from '../handler.ts';
import { VOICE_FAILURE_TWIML } from '../verify/twilio-voice.ts';

export interface VoiceCall {
  orgId: string;
  callSid: string;
  from: string;
  step: 'menu' | 'join' | 'consent';
  digits: string;
  visitId: string | null;
  /** The carrier vouched for the caller ID (STIR/SHAKEN full attestation: the carrier knows the caller may use the number). */
  verified: boolean;
}

export interface VoiceResult {
  handled: 'menu' | 'joined' | 'closed' | 'invalid' | 'consent' | 'bye';
  location?: string;
  queues?: string[];
  ticket?: string;
  position?: number;
  eta_low?: number | null;
  eta_high?: number | null;
  offer_text?: boolean;
  visit_id?: string;
}

/** The consent read aloud; its version is recorded with the consent (source ivr). */
export const IVR_CONSENT_VERSION = 'ivr-sms-1';
export const IVR_CONSENT_TEXT = 'Press 1 to get a text message when it is your turn. Message and data rates may apply. Reply STOP to opt out.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const say = (s: string) => `<Say language="en-US">${esc(s)}</Say>`;
const ticket = (t: string) => `<Say language="en-US"><say-as interpret-as="characters">${esc(t)}</say-as></Say>`;
const response = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const gather = (action: string, prompt: string, digits: number) =>
  `<Gather input="dtmf" numDigits="${digits}" timeout="6" action="${esc(action)}" method="POST">${prompt}</Gather>`;

export function voiceTwiml(r: VoiceResult, selfUrl: string): string {
  switch (r.handled) {
    case 'menu': {
      const qs = r.queues ?? [];
      const greeting = say(`Welcome to ${r.location}.`);
      if (qs.length === 0) return response(greeting + say('We are not taking people in line right now. Goodbye.') + '<Hangup/>');
      const prompt = qs.length === 1
        ? say('Press 1 to join the line.')
        : qs.map((q, i) => say(`Press ${i + 1} for ${q}.`)).join('');
      return response(gather(`${selfUrl}?step=join`, greeting + prompt, 1) + say('We did not get that. Goodbye.') + '<Hangup/>');
    }
    case 'joined': {
      const wait = r.eta_low != null && r.eta_high != null ? ` The estimated wait is ${r.eta_low} to ${r.eta_high} minutes.` : '';
      const head = say("You're in line. Your ticket is") + ticket(r.ticket ?? '') +
        say(`There ${r.position === 1 ? 'is' : 'are'} ${(r.position ?? 1) - 1} ahead of you.${wait}`);
      if (!r.offer_text || !r.visit_id) return response(head + say('Goodbye.') + '<Hangup/>');
      return response(gather(`${selfUrl}?step=consent&visit=${encodeURIComponent(r.visit_id)}`, head + say(IVR_CONSENT_TEXT), 1) + say('Goodbye.') + '<Hangup/>');
    }
    case 'consent':
      return response(say("Thank you. We'll text you when it's your turn. Goodbye.") + '<Hangup/>');
    case 'closed':
      return response(say("Sorry, we're not taking new people in line right now. Goodbye.") + '<Hangup/>');
    case 'invalid':
      return response(say('Sorry, that is not an option.') + `<Redirect method="POST">${esc(selfUrl)}?step=menu</Redirect>`);
    default:
      return response(say('Goodbye.') + '<Hangup/>');
  }
}

export function createTwilioVoiceHandler(call: (c: VoiceCall) => Promise<VoiceResult>): WebhookHandler {
  return async (ctx) => {
    const form = ctx.form;
    if (!form || !ctx.orgId) return { body: VOICE_FAILURE_TWIML, contentType: 'text/xml' };
    const query = ctx.query ?? new URLSearchParams();
    const step = query.get('step');
    const result = await call({
      orgId: ctx.orgId,
      callSid: form.get('CallSid') ?? '',
      from: form.get('From') ?? '',
      step: step === 'join' || step === 'consent' ? step : 'menu',
      digits: form.get('Digits') ?? '',
      visitId: query.get('visit'),
      verified: /^TN-Validation-Passed-A$/.test(form.get('StirVerstat') ?? ''),
    });
    return { body: voiceTwiml(result, ctx.selfUrl ?? ''), contentType: 'text/xml' };
  };
}
