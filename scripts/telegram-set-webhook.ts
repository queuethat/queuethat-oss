// Points the Telegram bot at the telegram-webhook Edge Function and stores the bot username the
// status page's deep link needs. Run: node scripts/telegram-set-webhook.ts <functions-url>
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the environment (see docs/ops/telegram.md).
const [functionsUrl] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!functionsUrl || !token || !secret) {
  console.error(
    'Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-set-webhook.ts <functions-url>',
  );
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
  console.error(
    'TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z a-z 0-9 _ - (Telegram rejects others).',
  );
  process.exit(1);
}

async function call(method: string, body?: object) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

const me = (await call('getMe')) as { username: string };
await call('setWebhook', {
  url: `${functionsUrl.replace(/\/$/, '')}/telegram-webhook`,
  secret_token: secret,
  allowed_updates: ['message'],
});
console.log(`Webhook set for @${me.username}.`);
console.log(`Store the username so deep links work (SQL editor, once):`);
console.log(`  select vault.create_secret('${me.username}', 'telegram_bot_username');`);
