// N-3 (#252): Telegram webhook. Links a guest's chat to their visit (/start <code>) and honours
// /stop. An Edge Function because only it holds the bot token and the service role (technical-design.md
// 3.5, rule 3). The gateway's JWT check is off; Telegram's secret header is the gate and is
// verified before anything else happens.
//
// POST  header X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET (set via setWebhook)
//   200 { ok: true }          the update was handled or deliberately ignored (Telegram must not retry)
//   401 { error: "unauthorized" }   missing or wrong secret header; nothing is read or written
//   405                       anything but POST
//   500 { error: "unknown" }  a dependency failed; Telegram retries the update

export interface TelegramJoinResult {
  handled: 'join' | 'join_closed' | 'unknown' | 'choose' | 'leave' | 'multiple' | 'unhandled';
  ticket?: string;
  position?: number;
  queue_name?: string;
}

export interface TelegramWebhookDeps {
  /** TELEGRAM_WEBHOOK_SECRET */
  secret: string;
  /** api.redeem_link_code */
  redeem(code: string, chatId: string): Promise<{ linked: boolean; visitId: string | null }>;
  /** api.unlink_telegram_chat */
  unlink(chatId: string): Promise<void>;
  /** api.process_telegram_message: /start <location slug>[_<keyword>] joins a queue, /leave cancels the chat's place. */
  message(chatId: string, updateId: string, text: string): Promise<TelegramJoinResult>;
  /** The display ticket of a visit, for the confirmation reply. */
  ticketOf(visitId: string): Promise<string | null>;
  /** Bot API sendMessage; a failure here never fails the webhook. */
  reply(chatId: string, text: string): Promise<void>;
  log?(message: string): void;
  error?(line: string, cause: unknown): void;
}

// English only for now: the bot has no guest locale until the chat is linked.
export const REPLIES = {
  linked: (ticket: string | null) =>
    ticket ? `You will get updates for ticket ${ticket}. Send /stop to stop them.` : 'You will get updates for your ticket. Send /stop to stop them.',
  failed: 'That link expired or was already used. Open your ticket page and tap the Telegram button again.',
  stopped: 'You will not get any more messages. Open your ticket page to turn them back on.',
  joined: (r: TelegramJoinResult) =>
    `You're in line at ${r.queue_name}: ticket ${r.ticket}, number ${r.position}. Send /leave to leave, or /stop to stop messages.`,
  closed: "Sorry, we're not taking new people in line right now.",
  unknown: "We couldn't find that line. Scan the code on the poster again.",
  choose: 'This venue has more than one line. Scan the code for the line you want.',
  left: "You've left the line.",
  multiple: "You're in more than one line. Open your ticket page to leave the one you want.",
  help: 'Open your ticket page and tap "Get updates on Telegram" to link this chat.',
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// A link code is 24 characters; a location slug (optionally _KEYWORD) can be shorter.
const START = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,100}))?\s*$/;
const LEAVE = /^\/leave(?:@\w+)?\s*$/;
const STOP = /^\/stop(?:@\w+)?\s*$/;

export function createTelegramWebhookHandler(deps: TelegramWebhookDeps): (req: Request) => Promise<Response> {
  const error = deps.error ?? ((line: string) => deps.log?.(line));
  return async (req) => {
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    if (!safeEqual(req.headers.get('x-telegram-bot-api-secret-token') ?? '', deps.secret)) {
      return json(401, { error: 'unauthorized' });
    }
    const update = await req.json().catch(() => null);
    const chat = update?.message?.chat;
    const text = update?.message?.text;
    // Groups and channels can't be linked: a chat id there isn't one guest.
    if (chat?.type !== 'private' || typeof chat.id !== 'number' || typeof text !== 'string'
        || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return json(200, { ok: true });
    }
    const chatId = String(chat.id);
    try {
      const start = START.exec(text.trim());
      if (start) {
        const code = start[1];
        if (!code) {
          await deps.reply(chatId, REPLIES.help).catch(() => {});
          return json(200, { ok: true });
        }
        const result = await deps.redeem(code, chatId);
        let message: string;
        if (result.linked && result.visitId) {
          message = REPLIES.linked(await deps.ticketOf(result.visitId).catch(() => null));
        } else {
          // Not a link code: the poster's deep link, which joins the location's queue.
          const joined = await deps.message(chatId, String(update.update_id), text.trim());
          message = joined.handled === 'join' ? REPLIES.joined(joined)
            : joined.handled === 'join_closed' ? REPLIES.closed
            : joined.handled === 'choose' ? REPLIES.choose
            : joined.handled === 'unknown' ? REPLIES.unknown
            : REPLIES.failed;
        }
        await deps.reply(chatId, message).catch((cause) => error('telegram reply failed', cause));
      } else if (LEAVE.test(text.trim())) {
        const left = await deps.message(chatId, String(update.update_id), text.trim());
        const message = left.handled === 'leave' ? REPLIES.left : left.handled === 'multiple' ? REPLIES.multiple : REPLIES.help;
        await deps.reply(chatId, message).catch((cause) => error('telegram reply failed', cause));
      } else if (STOP.test(text.trim())) {
        await deps.unlink(chatId);
        await deps.reply(chatId, REPLIES.stopped).catch((cause) => error('telegram reply failed', cause));
      }
      return json(200, { ok: true });
    } catch (cause) {
      error('telegram-webhook failed', cause);
      return json(500, { error: 'unknown' });
    }
  };
}
