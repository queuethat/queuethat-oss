// Telegram Bot API channel (N-3). Free, one bot per deployment (token = Edge Function secret).
// The recipient address is `tg:<chat_id>`, stored on the guest's telegram contact (2B-N2).
import { defineChannel, failed, type NotificationChannel } from '../channel.ts';

export interface TelegramChannelOptions {
  /** `TELEGRAM_BOT_TOKEN` from BotFather. */
  botToken: string;
  /** Label of the button that opens the guest's status page. The dispatcher passes the localized text. */
  buttonLabel?: string;
  /** Bot API origin; tests and local fakes override it. */
  apiBase?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const MAX_TEXT = 4096;

/** Sends plain text plus a deep-link button to `/v/<token>`. */
export function telegramChannel({
  botToken,
  buttonLabel = 'Open my ticket',
  apiBase = 'https://api.telegram.org',
  fetch: doFetch = fetch,
}: TelegramChannelOptions): NotificationChannel {
  return defineChannel({
    kind: 'telegram',
    providerName: 'telegram',
    async deliver(msg) {
      const chatId = msg.to.kind === 'address' ? /^tg:(-?\d{1,20})$/.exec(msg.to.value)?.[1] : null;
      if (!chatId)
        return failed(false, 'unsupported_recipient', 'telegram needs a tg:<chat_id> address');
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/bot${botToken}/sendMessage`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: msg.text.slice(0, MAX_TEXT),
            ...(msg.url
              ? { reply_markup: { inline_keyboard: [[{ text: buttonLabel, url: msg.url }]] } }
              : {}),
          }),
        });
      } catch (err) {
        // The error text can carry the request URL, which holds the bot token.
        return failed(true, 'network_error', String(err).replaceAll(botToken, '***'));
      }
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        parameters?: { retry_after?: number };
        result?: { message_id?: number };
      };
      if (res.ok && body.ok !== false) {
        return {
          status: 'sent',
          providerMessageId: String(body.result?.message_id ?? ''),
          costMicros: 0,
        };
      }
      const description = (body.description ?? '').slice(0, 200);
      // 403: the guest blocked the bot or deleted the chat. It will never succeed again.
      if (res.status === 403) return { status: 'gone', code: 'bot_blocked', message: description };
      if (res.status === 429) {
        return failed(
          true,
          'rate_limited',
          `retry_after=${body.parameters?.retry_after ?? '?'} ${description}`,
        );
      }
      return failed(res.status >= 500, `http_${res.status}`, description);
    },
  });
}
