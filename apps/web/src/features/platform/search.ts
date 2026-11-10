import type { OrgStatus } from './api.ts';

/** The directory's address: search text, status filter, this page's cursor and the cursors before it. */
export interface DirectorySearch {
  q?: string;
  status?: OrgStatus;
  /** Shows the tenants whose notes carry this tag instead of the paged list (#1135). */
  tag?: string;
  /** The last id of the previous page; absent on the first page. */
  after?: string;
  /** The cursors of the pages before this one, oldest first, comma-separated. */
  before?: string;
}

const STATUSES = new Set<string>(['active', 'suspended', 'pending_deletion']);
const TAG = /^[a-z0-9][a-z0-9-]{0,29}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Enough pages to walk back through; older cursors are dropped, and "first page" still works. */
const MAX_TRAIL = 20;

/**
 * Reads the directory's query string. Anything that isn't what the page wrote itself is dropped,
 * so a hand-edited or stale link opens the first page instead of an RPC error (#581).
 */
export function parseDirectorySearch(search: Record<string, unknown>): DirectorySearch {
  const trail = (typeof search.before === 'string' ? search.before : '')
    .split(',')
    .filter((cursor) => UUID.test(cursor))
    .slice(-MAX_TRAIL);
  const after = typeof search.after === 'string' && UUID.test(search.after) ? search.after : null;
  return {
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
    ...(typeof search.status === 'string' && STATUSES.has(search.status)
      ? { status: search.status as OrgStatus }
      : {}),
    ...(typeof search.tag === 'string' && TAG.test(search.tag.toLowerCase())
      ? { tag: search.tag.toLowerCase() }
      : {}),
    ...(after ? { after } : {}),
    ...(after && trail.length > 0 ? { before: trail.join(',') } : {}),
  };
}

/** The cursors of the pages before the current one. */
const trailOf = (search: DirectorySearch) => (search.before ? search.before.split(',') : []);

/**
 * Where "Previous page" and "Next page" go. Going on records this page's cursor in `before`;
 * going back pops it, so the trail always names the pages behind you.
 */
export function pageLinks(search: DirectorySearch, lastId: string | undefined) {
  const trail = trailOf(search);
  const previous = search.after
    ? {
        ...(trail.length > 0 ? { after: trail[trail.length - 1] } : {}),
        ...(trail.length > 1 ? { before: trail.slice(0, -1).join(',') } : {}),
      }
    : null;
  const next = lastId
    ? {
        after: lastId,
        ...(search.after ? { before: [...trail, search.after].slice(-MAX_TRAIL).join(',') } : {}),
      }
    : null;
  return { previous, next };
}
