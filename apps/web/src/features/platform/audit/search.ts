/** The audit page's address: filters (as the operator typed them), this page's cursor, the trail. */
export interface AuditSearch {
  /** Platform user id. */
  actor?: string;
  /** Business id. */
  org?: string;
  /** An exact action (`org.suspend`) or a family ending in a dot (`support.`). */
  action?: string;
  /** First local calendar day, `YYYY-MM-DD`, inclusive. */
  from?: string;
  /** Last local calendar day, `YYYY-MM-DD`, inclusive. */
  to?: string;
  /** The smallest id of the previous page; absent on the first page. */
  after?: string;
  /** The cursors of the pages before this one, oldest first, comma-separated. */
  before?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Fifteen digits stay exact as a JS number (ids are far below that).
const CURSOR = /^[1-9][0-9]{0,14}$/;
const ACTION = /^[a-z_]+(\.[a-z_]*)*$/;
const MAX_TRAIL = 20;

/** `YYYY-MM-DD` that names a real calendar day (so `2026-02-30` is out). */
export function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Reads the query string; anything the page didn't write itself is dropped (a stale link opens page one). */
export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  // The router's default query parsing turns `after=950` into the number 950, so accept both.
  const str = (key: string) => {
    const value = search[key];
    return typeof value === 'string'
      ? value.trim()
      : typeof value === 'number'
        ? String(value)
        : '';
  };
  const trail = str('before')
    .split(',')
    .filter((cursor) => CURSOR.test(cursor))
    .slice(-MAX_TRAIL);
  const after = CURSOR.test(str('after')) ? str('after') : null;
  const actor = str('actor');
  const org = str('org');
  const action = str('action');
  const from = str('from');
  const to = str('to');
  return {
    ...(UUID.test(actor) ? { actor: actor.toLowerCase() } : {}),
    ...(UUID.test(org) ? { org: org.toLowerCase() } : {}),
    ...(action.length <= 80 && ACTION.test(action) ? { action } : {}),
    ...(isCalendarDay(from) ? { from } : {}),
    ...(isCalendarDay(to) ? { to } : {}),
    ...(after ? { after } : {}),
    ...(after && trail.length > 0 ? { before: trail.join(',') } : {}),
  };
}

/** True when both days are set and the first is after the last. */
export function rangeInverted(search: Pick<AuditSearch, 'from' | 'to'>): boolean {
  return Boolean(search.from && search.to && search.from > search.to);
}

/** The local midnight that starts `day` (`YYYY-MM-DD`), shifted by `plusDays` calendar days. */
function localMidnight(day: string, plusDays: number): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date + plusDays);
}

/**
 * The instants the RPC wants for a range of local days: the start of the first day (inclusive) to
 * the start of the day after the last (exclusive). Built from local calendar fields, so a 23- or
 * 25-hour day around a clock change still covers exactly that day.
 */
export function rangeInstants(search: Pick<AuditSearch, 'from' | 'to'>): {
  from?: string;
  to?: string;
} {
  return {
    ...(search.from ? { from: localMidnight(search.from, 0).toISOString() } : {}),
    ...(search.to ? { to: localMidnight(search.to, 1).toISOString() } : {}),
  };
}

/** The cursors of the pages before the current one. */
const trailOf = (search: AuditSearch) => (search.before ? search.before.split(',') : []);

/** Where "Previous page" and "Next page" go; going on records this page's cursor, going back pops it. */
export function auditPageLinks(search: AuditSearch, lastId: number | undefined) {
  const trail = trailOf(search);
  const previous = search.after
    ? {
        ...(trail.length > 0 ? { after: trail[trail.length - 1] } : {}),
        ...(trail.length > 1 ? { before: trail.slice(0, -1).join(',') } : {}),
      }
    : null;
  const next =
    lastId === undefined
      ? null
      : {
          after: String(lastId),
          ...(search.after ? { before: [...trail, search.after].slice(-MAX_TRAIL).join(',') } : {}),
        };
  return { previous, next };
}

/** Just the filters, without any paging. */
export function auditFilters(search: AuditSearch): AuditSearch {
  const { after: _after, before: _before, ...filters } = search;
  return filters;
}
