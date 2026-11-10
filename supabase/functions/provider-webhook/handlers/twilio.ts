// Twilio inbound SMS -> api.process_inbound_message. Delivery-status callbacks (they carry
// MessageStatus) are 3-SMS2's; everything else here is a guest's text.
import type { WebhookHandler } from '../handler.ts';

export interface InboundMessage {
  orgId: string;
  channel: 'sms' | 'whatsapp';
  from: string;
  to: string;
  body: string;
  provider: string;
  providerMessageId: string;
}

export function createTwilioInboundHandler(
  processInbound: (m: InboundMessage) => Promise<unknown>,
): WebhookHandler {
  return async (ctx) => {
    const form = ctx.form;
    if (!form || !ctx.orgId || form.has('MessageStatus') || !form.has('Body')) return;
    await processInbound({
      orgId: ctx.orgId,
      channel: 'sms',
      from: form.get('From') ?? '',
      to: form.get('To') ?? '',
      body: form.get('Body') ?? '',
      provider: 'twilio',
      providerMessageId: form.get('MessageSid') ?? '',
    });
  };
}
