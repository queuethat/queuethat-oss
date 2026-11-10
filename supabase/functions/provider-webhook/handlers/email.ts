// 3-EM2 (#348): Resend and Postmark webhooks become the message's delivery status, and a hard
// bounce or spam complaint suppresses the address. The org comes from the verified endpoint and
// the address from the org's own message (api.suppress_by_message), never from the payload.
import type { WebhookHandler } from '../handler.ts';
import type { ApplyDeliveryStatus } from './twilio-status.ts';

/** api.suppress_by_message; false when the org has no such email message. */
export type SuppressByMessage = (
  orgId: string,
  provider: string,
  providerMessageId: string,
  reason: 'bounce' | 'complaint',
) => Promise<boolean>;

interface Outcome {
  messageId: string;
  status?: 'delivered' | 'undelivered' | 'failed';
  errorCode?: string;
  suppress?: 'bounce' | 'complaint';
}

function run(provider: string, parse: (payload: any) => Outcome | null, apply: ApplyDeliveryStatus, suppress: SuppressByMessage): WebhookHandler {
  return async ({ orgId, rawBody }) => {
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return;
    }
    const o = parse(payload);
    if (!orgId || !o?.messageId) return;
    // Suppress first: the safety effect must not depend on the status update.
    if (o.suppress) await suppress(orgId, provider, o.messageId, o.suppress);
    if (o.status) await apply(orgId, provider, o.messageId, o.status, o.errorCode);
  };
}

/** Resend events: email.delivered, email.bounced (data.bounce.type Permanent|Transient|Undetermined), email.complained. */
export function resendHandler(apply: ApplyDeliveryStatus, suppress: SuppressByMessage): WebhookHandler {
  return run('resend', (p) => {
    const messageId = p?.data?.email_id;
    if (typeof messageId !== 'string') return null;
    switch (p?.type) {
      case 'email.delivered':
        return { messageId, status: 'delivered' };
      case 'email.bounced':
        return p?.data?.bounce?.type === 'Permanent'
          ? { messageId, status: 'failed', errorCode: 'resend_bounce', suppress: 'bounce' }
          : { messageId, status: 'undelivered', errorCode: 'resend_bounce_soft' };
      case 'email.complained':
        return { messageId, suppress: 'complaint', errorCode: 'resend_complaint' };
      default:
        return null;
    }
  }, apply, suppress);
}

const POSTMARK_HARD = new Set(['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated']);

/** Postmark RecordTypes: Delivery, Bounce (Type names the kind), SpamComplaint. */
export function postmarkHandler(apply: ApplyDeliveryStatus, suppress: SuppressByMessage): WebhookHandler {
  return run('postmark', (p) => {
    const messageId = p?.MessageID;
    if (typeof messageId !== 'string') return null;
    switch (p?.RecordType) {
      case 'Delivery':
        return { messageId, status: 'delivered' };
      case 'Bounce':
        return POSTMARK_HARD.has(p?.Type)
          ? { messageId, status: 'failed', errorCode: 'postmark_bounce', suppress: 'bounce' }
          : { messageId, status: 'undelivered', errorCode: 'postmark_bounce_soft' };
      case 'SpamComplaint':
        return { messageId, suppress: 'complaint', errorCode: 'postmark_complaint' };
      default:
        return null;
    }
  }, apply, suppress);
}
