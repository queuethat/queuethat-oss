/**
 * The `src` hint a join carries (2B-J8): `?src=gbp` on a Google Business Profile link, `poster` on a
 * poster's QR code, and `widget` when the join page is embedded. Sent as typed (lower-case letters,
 * at most 12); public-join keeps it only if it is one of its allowlisted values, so nothing a link
 * says is ever stored.
 */
export function joinSource(search: string, widget = false): string | null {
  if (widget) return 'widget';
  const value = new URLSearchParams(search).get('src')?.trim().toLowerCase() ?? '';
  return /^[a-z]{1,12}$/.test(value) ? value : null;
}
