import { publicJoinUrl } from '../../poster/url.ts';

/** The join link for a Google Business Profile: the public join page with `?src=gbp` (2B-J8). */
export function gbpLink(slug: string, base?: string): string {
  const url = new URL(publicJoinUrl(slug, base));
  url.searchParams.set('src', 'gbp');
  return url.href;
}
