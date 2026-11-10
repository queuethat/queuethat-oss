// 3-SMS4 (#353): Vonage webhooks. A body with `status` is a delivery report
// (api.apply_delivery_status); one with `text` and no status is a guest's text
// (api.process_inbound_message).
import type { WebhookHandler } from '../handler.ts';
import type { ApplyDeliveryStatus } from './twilio-status.ts';
import type { InboundMessage } from './twilio.ts';

const STATUS: Record<string, string> = {
  submitted: 'sent',
  delivered: 'delivered',
  undeliverable: 'undelivered',
  rejected: 'failed',
};

export function createVonageHandler(
  apply: ApplyDeliveryStatus,
  processInbound: (m: InboundMessage) => Promise<unknown>,
): WebhookHandler {
  return async ({ orgId, rawBody }) => {
    // The org comes from the verified endpoint, never from the payload.
    if (!orgId) return;
    const e = JSON.parse(new TextDecoder().decode(rawBody)) as {
      message_uuid?: string; status?: string; text?: string; from?: string; to?: string; error?: { code?: string };
    };
    if (!e.message_uuid) return;
    if (e.status === undefined) {
      if (e.text === undefined) return;
      // Vonage numbers carry no leading plus.
      const e164 = (n?: string) => (n ? `+${n.replace(/^\+/, '')}` : '');
      await processInbound({
        orgId, channel: 'sms', from: e164(e.from), to: e164(e.to), body: e.text,
        provider: 'vonage', providerMessageId: e.message_uuid,
      });
      return;
    }
    const status = STATUS[e.status];
    if (!status) return;
    const code = e.error?.code;
    await apply(orgId, 'vonage', e.message_uuid, status, code ? `vonage_${code}` : undefined);
  };
}
