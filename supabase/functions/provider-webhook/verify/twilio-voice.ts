import { twilio } from './twilio.ts';
import type { WebhookVerifier } from './types.ts';

/** The caller hears this when the handler fails, never silence. */
export const VOICE_FAILURE_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Sorry, something went wrong. Please try again later.</Say><Hangup/></Response>';

/** Twilio Voice webhooks: the same X-Twilio-Signature and auth token as Twilio SMS, answered with TwiML. */
export const twilioVoice: WebhookVerifier = {
  provider: 'twilio-voice',
  secretsProvider: 'twilio',
  inlineResponse: true,
  failureReply: VOICE_FAILURE_TWIML,
  verify: twilio.verify,
  // One key per caller keypress. The step is in the signed query string, not the body.
  eventKeys(_raw, form) {
    const sid = form?.get('CallSid');
    return sid ? [`${sid}:${form?.get('Digits') ?? ''}`] : [];
  },
};
