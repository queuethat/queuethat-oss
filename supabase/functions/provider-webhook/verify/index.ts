// The verifier registry. A new provider (Postmark, Resend, Telnyx) adds a file here.
import { meta } from './meta.ts';
import { plivo } from './plivo.ts';
import { postmark } from './postmark.ts';
import { resend } from './resend.ts';
import { square } from './square.ts';
import { stripe } from './stripe.ts';
import { telnyx } from './telnyx.ts';
import { twilio } from './twilio.ts';
import { twilioVoice } from './twilio-voice.ts';
import { vonage } from './vonage.ts';
import type { WebhookVerifier } from './types.ts';

// The platform number signs with the account's auth token; it shares Twilio's signature scheme. It answers
// inline so a free-text opt-out gets its confirmation (TwiML); every other event gets the empty <Response/>.
const twilioPlatform: WebhookVerifier = {
  ...twilio,
  provider: 'twilio-platform',
  inlineResponse: true,
  failureReply: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
};

export const verifiers: Record<string, WebhookVerifier> = {
  twilio,
  'twilio-platform': twilioPlatform,
  'twilio-voice': twilioVoice,
  stripe,
  meta,
  telnyx,
  vonage,
  plivo,
  resend,
  postmark,
  square,
};
