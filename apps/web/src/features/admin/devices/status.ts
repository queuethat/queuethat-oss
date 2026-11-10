/** A screen that hasn't sent a heartbeat for this long shows as offline (D2, #49). */
export const OFFLINE_AFTER_MS = 5 * 60_000;

/**
 * Whether a paired screen counts as online, and how long ago it was last seen. Heartbeats come
 * every minute (D3), so five minutes of silence means the screen froze, lost power or Wi-Fi.
 * A screen that has never sent one is offline.
 */
export function deviceStatus(lastSeenAt: string | null, now: number) {
  if (!lastSeenAt) return { online: false, agoMs: undefined };
  const agoMs = Math.max(0, now - Date.parse(lastSeenAt));
  return { online: agoMs < OFFLINE_AFTER_MS, agoMs };
}

/**
 * A screen paired in the last five minutes that hasn't sent its first heartbeat yet. It shows as
 * connecting rather than offline, and the list checks on it more often.
 */
export function isConnecting(
  device: { last_seen_at: string | null; created_at: string },
  now: number,
) {
  return !device.last_seen_at && now - Date.parse(device.created_at) < OFFLINE_AFTER_MS;
}

/** The largest whole unit that fits `ms`, for `Intl.RelativeTimeFormat`. */
export function relativeAgo(ms: number): { value: number; unit: 'minute' | 'hour' | 'day' } {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { value: -minutes, unit: 'minute' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: -hours, unit: 'hour' };
  return { value: -Math.floor(hours / 24), unit: 'day' };
}

/** `m:ss` left until `expiresAt`, or null once it has passed. */
export function countdown(expiresAt: string, now: number): string | null {
  const left = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
