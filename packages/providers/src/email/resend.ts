// Resend (https://resend.com/docs/api-reference/emails/send-email). The outbox id is the
// Idempotency-Key, so a retry after a lost response can't send twice.
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';
import {
  formatAddress,
  isSingleAddress,
  type HttpEmailOptions,
  mailHeaders,
  postJson,
  textBody,
} from './shared.ts';

export function resendEmailChannel({
  apiKey,
  from,
  replyTo,
  baseUrl = 'https://api.resend.com',
  fetch: doFetch = fetch,
}: HttpEmailOptions): NotificationChannel {
  return defineChannel({
    kind: 'email',
    providerName: 'resend',
    async deliver(msg) {
      if (msg.to.kind !== 'address') {
        return failed(false, 'unsupported_recipient', 'email needs an address recipient');
      }
      if (!isSingleAddress(msg.to.value)) {
        return failed(false, 'invalid_recipient', 'recipient is not a single email address');
      }
      const call = await postJson(
        doFetch,
        new URL('/emails', baseUrl).href,
        { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': msg.outboxId },
        {
          from: formatAddress(from),
          to: [msg.to.value],
          ...(replyTo ? { reply_to: replyTo } : {}),
          subject: msg.subject ?? '',
          text: textBody(msg),
          ...(msg.html ? { html: msg.html } : {}),
          headers: mailHeaders(msg),
        },
        // Resend reports every field problem as 422 validation_error; only an address one counts.
        (json) => /\b(to|email|address|recipient)\b/i.test(String(json.message ?? '')),
      );
      if (!call.ok) return call.result;
      return { status: 'sent', providerMessageId: String(call.json.id ?? ''), costMicros: 0 };
    },
  });
}
