import { appConfig } from '../../../lib/config.ts';

/**
 * The join page address printed on posters: `/q/{slug}` on the configured public URL
 * (`PUBLIC_URL`, lib/config.ts), else this browser's origin. Set it when admins use a different address
 * from guests (a LAN IP, an admin subdomain). `/q` is frozen (I-10): posters outlive versions.
 */
export function publicJoinUrl(
  slug: string,
  base: string = appConfig().publicUrl || window.location.origin,
): string {
  return new URL(`/q/${encodeURIComponent(slug)}`, base).href;
}

/**
 * The Telegram deep link for a location's poster. The bot serves every org, so the start payload names
 * the location (`slug`), plus a queue keyword (`slug_KEYWORD`) when the location has several queues.
 * Null when a multi-queue location has no keyword to name one. The bot reads it in telegram-webhook.
 */
export function telegramJoinUrl(
  bot: string,
  slug: string,
  queues: ReadonlyArray<{ sms_keyword: string | null }>,
): string | null {
  const keyword = queues.find((q) => q.sms_keyword)?.sms_keyword;
  if (queues.length === 0 || (queues.length > 1 && !keyword)) return null;
  const payload = queues.length === 1 ? slug : `${slug}_${keyword}`;
  return `https://t.me/${bot}?start=${payload}`;
}
