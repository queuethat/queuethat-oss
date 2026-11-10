/** Where staff land after signing in when nothing else was asked for. */
export const DEFAULT_NEXT = '/staff';

/** An /auth/ page `safeNext` allows: where an invitation link is accepted. */
export const INVITE_PATH = '/auth/accept-invite';

/** The other one: where a password-recovery link or code lands to choose a new password. */
export const RESET_PATH = '/auth/reset-password';

/**
 * Returns `next` when it is a path on this site, otherwise `DEFAULT_NEXT`. Every post-sign-in
 * redirect goes through this, so a crafted `?next=` link can't send someone to another site.
 * The browser's own URL parser decides, so `//host`, `/\\host` and tab tricks resolve the way
 * navigation would.
 */
export function safeNext(next: unknown, origin: string = window.location.origin): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return DEFAULT_NEXT;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return DEFAULT_NEXT;
  }
  if (url.origin !== origin) return DEFAULT_NEXT;
  // Other /auth/ paths would loop back through sign-in; an invitation link is how a signed-out
  // invitee returns to accept it, and a recovery link ends on the reset page.
  if (
    url.pathname.startsWith('/auth/') &&
    url.pathname !== INVITE_PATH &&
    url.pathname !== RESET_PATH
  )
    return DEFAULT_NEXT;
  const path = url.pathname + url.search + url.hash;
  // A normalised `/.//host` becomes `//host`, which navigation reads as another site.
  return path.startsWith('//') ? DEFAULT_NEXT : path;
}
