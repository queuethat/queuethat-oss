// 3-SMS2 (#351): Twilio status callbacks (MessageStatus) become the message's delivery status.
// Registered under `twilio` in index.ts; the inbound-keyword handler (3-CG8) composes with it.
import type { WebhookHandler } from '../handler.ts';

/** api.apply_delivery_status; false when the org has no message with that id. */
export type ApplyDeliveryStatus = (
  orgId: string,
  provider: string,
  providerMessageId: string,
  status: string,
  errorCode?: string,
) => Promise<boolean>;

/** Twilio's MessageStatus values mapped to ours. Anything else (inbound `received`, ...) is ignored. */
const STATUS: Record<string, string> = {
  accepted: 'queued',
  scheduled: 'queued',
  queued: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
};

export function twilioStatusHandler(apply: ApplyDeliveryStatus): WebhookHandler {
  return async ({ orgId, form }) => {
    const sid = form?.get('MessageSid') ?? form?.get('SmsSid');
    const status = STATUS[(form?.get('MessageStatus') ?? '').toLowerCase()];
    // The org comes from the verified endpoint, never from the payload (AccountSid is not trusted).
    if (!orgId || !sid || !status) return;
    const code = form?.get('ErrorCode');
    await apply(orgId, 'twilio', sid, status, code ? `twilio_${code}` : undefined);
  };
}
