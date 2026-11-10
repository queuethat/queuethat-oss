/** One earlier join, kept only in this browser. No token, no contact data: see 4-GX1 (#384). */
export interface JoinHistoryEntry {
  slug: string;
  queueId: string | null;
  serviceId: string | null;
  name: string;
  /** ISO timestamp of the join. */
  at: string;
}

const KEY = 'qm:join-history';
/** Oldest entries fall off past this many. */
export const HISTORY_LIMIT = 10;

function isEntry(value: unknown): value is JoinHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  const text = (v: unknown) => v === null || typeof v === 'string';
  return (
    typeof e.slug === 'string' &&
    typeof e.name === 'string' &&
    typeof e.at === 'string' &&
    text(e.queueId) &&
    text(e.serviceId)
  );
}

/** Recent joins, newest first. Empty when nothing is saved, the data is damaged or storage is blocked. */
export function readHistory(): JoinHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** The newest join at this location, to prefill its join page. */
export function historyFor(slug: string): JoinHistoryEntry | null {
  return readHistory().find((e) => e.slug === slug) ?? null;
}

/** Saves a finished join. A repeat of the same queue replaces its older entry. */
export function recordJoin(entry: JoinHistoryEntry): void {
  const rest = readHistory().filter((e) => !(e.slug === entry.slug && e.queueId === entry.queueId));
  try {
    localStorage.setItem(KEY, JSON.stringify([entry, ...rest].slice(0, HISTORY_LIMIT)));
  } catch {
    // storage blocked (private mode): the join page just starts empty next time
  }
}

/** "Forget my history". */
export function forgetHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing was stored
  }
}
