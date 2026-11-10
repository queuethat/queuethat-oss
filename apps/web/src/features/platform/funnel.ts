// No import of api.ts values here: the route's validateSearch runs in the entry bundle, and api.ts
// pulls in the Supabase client, which guest pages must not download (160 KB budget).

/** The stages the database reports, in funnel order. The last two are side milestones. */
export const FUNNEL_STAGES = [
  'signed_up',
  'business_created',
  'location_added',
  'queue_created',
  'line_live',
  'first_guest',
  'first_served',
  'staff_invite_accepted',
  'card_on_file',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
/** The stages a tenant can be stuck at: everything on the main path before `first_served`. */
export const STUCK_STAGES = [
  'business_created',
  'location_added',
  'queue_created',
  'line_live',
  'first_guest',
] as const;
export type StuckStage = (typeof STUCK_STAGES)[number];

export interface FunnelFilter {
  from?: string | undefined;
  to?: string | undefined;
  stage?: StuckStage | undefined;
  /** Zero-based page of the stuck list. */
  page?: number | undefined;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written YYYY-MM-DD (not 2026-02-31). */
export function isDay(value: unknown): value is string {
  const m = typeof value === 'string' ? DAY.exec(value) : null;
  if (!m) return false;
  const date = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return date.toISOString().slice(0, 10) === value;
}

/** Most pages the address may ask for; the stuck list is a short list, not an archive. */
const MAX_PAGE = 1000;

/**
 * Reads `/platform/funnel`'s query string. Whatever the page did not write itself is dropped, so
 * a hand-edited link shows the default funnel instead of an RPC error. A range with `from` after
 * `to` is dropped as a whole.
 */
export function parseFunnelSearch(search: Record<string, unknown>): FunnelFilter {
  const from = isDay(search.from) ? search.from : undefined;
  const to = isDay(search.to) ? search.to : undefined;
  const ordered = !from || !to || from <= to;
  const page = Number(search.page);
  return {
    ...(ordered && from ? { from } : {}),
    ...(ordered && to ? { to } : {}),
    ...(typeof search.stage === 'string' &&
    (STUCK_STAGES as readonly string[]).includes(search.stage)
      ? { stage: search.stage as StuckStage }
      : {}),
    ...(Number.isInteger(page) && page > 0 && page <= MAX_PAGE ? { page } : {}),
  };
}

/** A 0-1 ratio as a whole percent, or an en dash when there was nothing to divide by. */
export function percent(ratio: number | null, locale: string): string {
  return ratio === null
    ? '–'
    : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

/** A bar's width as a CSS percent of the widest stage; a stage that was reached shows at least a sliver. */
export function barWidth(count: number, max: number): string {
  if (count <= 0 || max <= 0) return '0%';
  return `${Math.max(2, Math.round((count / max) * 100))}%`;
}
