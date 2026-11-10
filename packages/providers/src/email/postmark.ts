// Postmark (https://postmarkapp.com/developer/api/email-api). The outbox id travels as
// Metadata and an X-Outbox-Id header; Postmark has no idempotency key, so the dispatcher's
// lease is what prevents a double send.
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';
import {
  formatAddress,
  isSingleAddress,
  type HttpEmailOptions,
  mailHeaders,
  postJson,
  textBody,
} from './shared.ts';

export interface PostmarkOptions extends HttpEmailOptions {
  /** Postmark message stream; transactional mail belongs on 'outbound'. */
  messageStream?: string;
}

// ErrorCode 300 invalid email, 406 recipient deactivated (bounced or complained before).
const INVALID_RECIPIENT = new Set([300, 406]);

export function postmarkEmailChannel({
  apiKey,
  from,
  replyTo,
  baseUrl = 'https://api.postmarkapp.com',
  messageStream = 'outbound',
  fetch: doFetch = fetch,
}: PostmarkOptions): NotificationChannel {
  return defineChannel({
    kind: 'email',
    providerName: 'postmark',
    async deliver(msg) {
      if (msg.to.kind !== 'address') {
        return failed(false, 'unsupported_recipient', 'email needs an address recipient');
      }
      if (!isSingleAddress(msg.to.value)) {
        return failed(false, 'invalid_recipient', 'recipient is not a single email address');
      }
      const call = await postJson(
        doFetch,
        new URL('/email', baseUrl).href,
        { 'X-Postmark-Server-Token': apiKey },
        {
          From: formatAddress(from),
          To: msg.to.value,
          ...(replyTo ? { ReplyTo: replyTo } : {}),
          Subject: msg.subject ?? '',
          TextBody: textBody(msg),
          ...(msg.html ? { HtmlBody: msg.html } : {}),
          MessageStream: messageStream,
          Headers: Object.entries(mailHeaders(msg)).map(([Name, Value]) => ({ Name, Value })),
          Metadata: { outbox_id: msg.outboxId },
        },
        (json) => INVALID_RECIPIENT.has(Number(json.ErrorCode)),
      );
      if (!call.ok) return call.result;
      return {
        status: 'sent',
        providerMessageId: String(call.json.MessageID ?? ''),
        costMicros: 0,
      };
    },
  });
}
