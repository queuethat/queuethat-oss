// 3-SMS5 (#354): Plivo callbacks. A request with `Status` is a delivery report
// (api.apply_delivery_status); one with `Text` and no status is a guest's text
// (api.process_inbound_message).
import type { WebhookHandler } from '../handler.ts';
import type { ApplyDeliveryStatus } from './twilio-status.ts';
import type { InboundMessage } from './twilio.ts';

const STATUS: Record<string, string> = {
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
  rejected: 'failed',
};

// Plivo numbers carry no leading plus.
const e164 = (n: string | null) => (n ? `+${n.replace(/^\+/, '')}` : '');

export function createPlivoHandler(
  apply: ApplyDeliveryStatus,
  processInbound: (m: InboundMessage) => Promise<unknown>,
): WebhookHandler {
  return async ({ orgId, form }) => {
    // The org comes from the verified endpoint, never from the payload.
    const id = form?.get('MessageUUID');
    if (!orgId || !form || !id) return;
    const raw = form.get('Status');
    if (raw === null) {
      const text = form.get('Text');
      if (text === null) return;
      await processInbound({
        orgId, channel: 'sms', from: e164(form.get('From')), to: e164(form.get('To')), body: text,
        provider: 'plivo', providerMessageId: id,
      });
      return;
    }
    const status = STATUS[raw.toLowerCase()];
    if (!status) return;
    const code = form.get('ErrorCode');
    await apply(orgId, 'plivo', id, status, code ? `plivo_${code}` : undefined);
  };
}
