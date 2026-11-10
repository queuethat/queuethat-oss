/**
 * How a waiting app update is applied on a given page.
 * - `prompt`: staff and admin choose when to reload, so they never lose half-entered work.
 * - `auto`: unattended displays and kiosks reload as soon as the update is ready.
 * - `silent`: guests get the update the next time they open the app.
 */
export type UpdatePolicy = 'prompt' | 'auto' | 'silent';

const PROMPT_PREFIXES = ['/staff', '/admin', '/auth'];
const AUTO_PREFIXES = ['/display', '/kiosk'];

const matches = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function updatePolicyFor(pathname: string): UpdatePolicy {
  if (PROMPT_PREFIXES.some((p) => matches(pathname, p))) return 'prompt';
  if (AUTO_PREFIXES.some((p) => matches(pathname, p))) return 'auto';
  return 'silent';
}
