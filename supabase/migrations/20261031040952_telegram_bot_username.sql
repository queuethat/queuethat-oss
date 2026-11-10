-- 4-BOT2 follow-up (#382): the poster shows the Telegram join link, which needs the bot's username.
-- It lives in Vault (telegram_bot_username), which clients cannot read. A bot username is public by
-- nature (it is the t.me address), so this returns that and nothing else. Expand-only.
-- Why a new RPC: no existing one exposes the bot, and guest_create_link_code needs a visit token.
-- Signed-in only: the poster is an admin page, so anon gets nothing.

create function api.get_telegram_bot() returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  where s.name = 'telegram_bot_username' and s.decrypted_secret ~ '^[A-Za-z0-9_]{5,32}$'
$$;
comment on function api.get_telegram_bot() is
  'The deployment''s Telegram bot username (no @), or null when no bot is configured or the stored value is not a valid '
  'username. Nothing else from Vault. Signed-in callers only; used by the poster to print the t.me join link.';
revoke all on function api.get_telegram_bot() from public, anon;
grant execute on function api.get_telegram_bot() to authenticated, service_role;

notify pgrst, 'reload schema';
