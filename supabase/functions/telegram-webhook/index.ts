// telegram-webhook entry point. The logic and its contract are in handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createObserver } from '../_shared/observe.ts';
import { createTelegramWebhookHandler } from './handler.ts';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const botToken = env('TELEGRAM_BOT_TOKEN');
const client = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const observe = createObserver('telegram-webhook', Deno.env.get('SENTRY_DSN'));

Deno.serve(
  observe.serve(createTelegramWebhookHandler({
    secret: env('TELEGRAM_WEBHOOK_SECRET'),
    async redeem(code, chatId) {
      const { data, error } = await client.schema('api').rpc('redeem_link_code', {
        p_code: code,
        p_chat_id: chatId,
      });
      if (error) throw new Error(error.message);
      return { linked: data?.linked === true, visitId: data?.visit_id ?? null };
    },
    async unlink(chatId) {
      const { error } = await client.schema('api').rpc('unlink_telegram_chat', { p_chat_id: chatId });
      if (error) throw new Error(error.message);
    },
    async message(chatId, updateId, text) {
      const { data, error } = await client.schema('api').rpc('process_telegram_message', {
        p_chat_id: chatId,
        p_update_id: updateId,
        p_text: text,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    async ticketOf(visitId) {
      const { data } = await client.schema('app').from('visits').select('display_ticket').eq('id', visitId).maybeSingle();
      return data?.display_ticket ?? null;
    },
    async reply(chatId, text) {
      // The URL carries the bot token, so a network error must not reach the logs as thrown.
      const res = await fetch(
        `${Deno.env.get('TELEGRAM_API_BASE') ?? 'https://api.telegram.org'}/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      ).catch(() => {
        throw new Error('sendMessage failed');
      });
      if (!res.ok) throw new Error(`sendMessage ${res.status}`);
    },
    log: observe.log,
    error: observe.error,
  })),
);
