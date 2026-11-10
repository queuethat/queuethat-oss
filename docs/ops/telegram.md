# Telegram notifications (N-3)

Free, one bot per deployment. Guests tap "Get updates on Telegram" on their status page, which
opens `t.me/<bot>?start=<code>`; the webhook redeems the code and links the chat to their visit.

## Set up
1. In Telegram, message `@BotFather`, send `/newbot`, and copy the token.
2. Pick a webhook secret: 16 to 256 characters from `A-Z a-z 0-9 _ -` (`openssl rand -hex 24`).
3. Set Edge Function secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` (never in `apps/web`).
   The dispatcher registers the channel when the token is present; without it Telegram is simply off.
4. `node scripts/telegram-set-webhook.ts https://<project>.supabase.co/functions/v1` calls
   `setWebhook` with the secret and prints the SQL that stores the bot username in Vault
   (`telegram_bot_username`); `api.guest_create_link_code` refuses until it exists.

## Behaviour
- Codes are single use, expire after 15 minutes and are stored only as sha256. A visit keeps its five newest.
- The webhook checks `X-Telegram-Bot-Api-Secret-Token` (constant time) before reading the body, ignores
  groups and channels, and answers 200 to anything it handles so Telegram doesn't retry.
- Linking records a `tg:<chat_id>` contact and a transactional consent with source `telegram_start`.
- `/stop` revokes the consent and suppresses the chat in every org that has it; `/start <code>` again re-subscribes.
- A 403 "bot was blocked" on send marks the message `gone` and suppresses the chat.
- Bot replies are English only until guest locales reach the webhook.
