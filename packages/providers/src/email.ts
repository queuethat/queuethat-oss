// Email through Mailpit's HTTP send API (the mail catcher `supabase start` runs on :55324).
// HTTP rather than SMTP because hosted Edge Functions can't open ports 25 or 587, and the paid
// email providers we'd plug in later (Resend, Postmark, SES) are HTTP APIs too.
import { defineChannel, failed, type NotificationChannel } from './channel.ts';

export interface MailpitEmailOptions {
  /** Mailpit base URL, e.g. http://127.0.0.1:55324. */
  baseUrl: string;
  from: { email: string; name?: string };
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Sends email to the local mail catcher. Every message is caught; nothing reaches a real inbox. */
export function mailpitEmailChannel({
  baseUrl,
  from,
  fetch: doFetch = fetch,
}: MailpitEmailOptions): NotificationChannel {
  return defineChannel({
    kind: 'email',
    providerName: 'mailpit',
    async deliver(msg) {
      if (msg.to.kind !== 'address') {
        return failed(false, 'unsupported_recipient', 'email needs an address recipient');
      }
      let res: Response;
      try {
        res = await doFetch(new URL('/api/v1/send', baseUrl), {
          method: 'POST',
          // Well inside the dispatcher's 60 s lease, so a hung send can't overlap a reclaim.
          signal: AbortSignal.timeout(20_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            From: { Email: from.email, Name: from.name ?? '' },
            To: [{ Email: msg.to.value }],
            Subject: msg.subject ?? '',
            Text: msg.url ? `${msg.text}\n\n${msg.url}` : msg.text,
            ...(msg.html ? { HTML: msg.html } : {}),
            Headers: {
              'X-Outbox-Id': msg.outboxId,
              ...(msg.unsubscribeUrl
                ? {
                    'List-Unsubscribe': `<${msg.unsubscribeUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                  }
                : {}),
            },
          }),
        });
      } catch (err) {
        return failed(true, 'network_error', String(err));
      }
      if (!res.ok) {
        // 429 and 5xx are worth retrying; any other 4xx is our request's fault.
        const retryable = res.status === 429 || res.status >= 500;
        return failed(retryable, `http_${res.status}`, (await res.text()).slice(0, 200));
      }
      // Accepted even if the body isn't the JSON we expect, so a parse error can't cause a resend.
      const { ID } = (await res.json().catch(() => ({}))) as { ID?: string };
      return { status: 'sent', providerMessageId: ID, costMicros: 0 };
    },
  });
}
