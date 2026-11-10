// 3-SMS3 (#352): Telnyx webhooks. message.sent/finalized become the message's delivery status
// (api.apply_delivery_status); message.received is a guest's text (api.process_inbound_message).
import type { WebhookHandler } from '../handler.ts';
import type { ApplyDeliveryStatus } from './twilio-status.ts';
import type { InboundMessage } from './twilio.ts';

const STATUS: Record<string, string> = {
  queued: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  delivery_unconfirmed: 'undelivered',
  sending_failed: 'failed',
  delivery_failed: 'failed',
};

interface Payload {
  id?: string;
  text?: string;
  from?: { phone_number?: string };
  to?: Array<{ phone_number?: string; status?: string }>;
  errors?: Array<{ code?: string }>;
}

export function createTelnyxHandler(
  apply: ApplyDeliveryStatus,
  processInbound: (m: InboundMessage) => Promise<unknown>,
): WebhookHandler {
  return async ({ orgId, rawBody }) => {
    // The org comes from the verified endpoint, never from the payload.
    if (!orgId) return;
    const event = JSON.parse(new TextDecoder().decode(rawBody))?.data as
      | { event_type?: string; payload?: Payload }
      | undefined;
    const p = event?.payload;
    if (!p?.id) return;
    if (event?.event_type === 'message.received') {
      await processInbound({
        orgId,
        channel: 'sms',
        from: p.from?.phone_number ?? '',
        to: p.to?.[0]?.phone_number ?? '',
        body: p.text ?? '',
        provider: 'telnyx',
        providerMessageId: p.id,
      });
      return;
    }
    if (event?.event_type !== 'message.sent' && event?.event_type !== 'message.finalized') return;
    const status = STATUS[p.to?.[0]?.status ?? ''];
    if (!status) return;
    const code = p.errors?.[0]?.code;
    await apply(orgId, 'telnyx', p.id, status, code ? `telnyx_${code}` : undefined);
  };
}
