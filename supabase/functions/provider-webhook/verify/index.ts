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

export const verifiers: Record<string, WebhookVerifier> = {
  twilio,
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
