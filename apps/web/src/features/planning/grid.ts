import { addDays, localDate } from '../booking/slots.ts';

// Pure placement for the planning grid: where an instant falls on a day's 15-minute columns. The
// database owns which appointments, blocks and shifts exist; this only positions them.

export const SLOT_MIN = 15;
/** The grid shows 07:00 to 21:00; anything outside is clipped to the edge. */
export const DAY_START_MIN = 7 * 60;
export const DAY_END_MIN = 21 * 60;
export const COLUMNS = (DAY_END_MIN - DAY_START_MIN) / SLOT_MIN;

function wallMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return num('hour') * 60 + num('minute');
}

/** Minutes from local midnight of `day` to the instant on the wall clock of `tz` (negative before it). */
export function minutesFromDayStart(instant: string | Date, tz: string, day: string): number {
  const at = new Date(instant);
  const dayDiff =
    (Date.parse(`${localDate(at, tz)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
  return dayDiff * 1440 + wallMinutes(at, tz);
}

export interface Span {
  /** Left edge and width as fractions of the grid width, 0 to 1. */
  left: number;
  width: number;
}

/** Where [start, end) falls on `day`'s columns, or null when it does not touch the visible window. */
export function spanOnDay(start: string, end: string, tz: string, day: string): Span | null {
  const from = Math.max(minutesFromDayStart(start, tz, day), DAY_START_MIN);
  const to = Math.min(minutesFromDayStart(end, tz, day), DAY_END_MIN);
  if (to <= from) return null;
  const total = DAY_END_MIN - DAY_START_MIN;
  return { left: (from - DAY_START_MIN) / total, width: (to - from) / total };
}

/** `YYYY-MM-DD` of the `n` days starting at `from`. */
export function daysFrom(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

export const UNASSIGNED = 'unassigned';

export interface ResourceLike {
  id: string;
  kind: string;
  member_user_id: string | null;
}

/**
 * The row an appointment sits in: the staff resource of its staff member, else the first resource
 * its service is mapped to (the same rule api.block_time_bulk uses for conflicts), else unassigned.
 */
export function rowForAppointment(
  a: { staff_user_id: string | null; service_id: string },
  resources: readonly ResourceLike[],
  serviceResources: readonly { service_id: string; counter_id: string }[],
): string {
  const own =
    a.staff_user_id &&
    resources.find((r) => r.kind === 'staff' && r.member_user_id === a.staff_user_id);
  if (own) return own.id;
  const mapped = serviceResources.find(
    (m) => m.service_id === a.service_id && resources.some((r) => r.id === m.counter_id),
  );
  return mapped?.counter_id ?? UNASSIGNED;
}

/** The row a shift sits in: its counter, else the staff resource of its person, else none. */
export function rowForShift(
  s: { counter_id: string | null; user_id: string },
  resources: readonly ResourceLike[],
): string | null {
  if (s.counter_id && resources.some((r) => r.id === s.counter_id)) return s.counter_id;
  return resources.find((r) => r.kind === 'staff' && r.member_user_id === s.user_id)?.id ?? null;
}

/** `2026-12-21 15:10:00+00` as an ISO instant every browser parses. */
function toIso(text: string): string {
  return text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
}

/** Parses a PostgREST tstzrange (`["a","b")`) into its two instants. */
export function parseRange(range: unknown): { start: string; end: string } | null {
  const m = /^[[(]"?([^",]+)"?,"?([^",)\]]+)"?[)\]]$/.exec(String(range));
  return m ? { start: toIso(m[1]!), end: toIso(m[2]!) } : null;
}

/** The instant at `minutes` after local midnight of `day` on the wall clock of `tz`. */
export function zonedInstant(day: string, minutes: number, tz: string): Date {
  let guess = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  // The zone's offset can differ from the guess's; two corrections settle it, DST edges included.
  for (let i = 0; i < 2; i++) {
    guess += (minutes - minutesFromDayStart(new Date(guess), tz, day)) * 60_000;
  }
  return new Date(guess);
}

/** Appointments in the given rows that overlap [start, end): what a block would run into. */
export function conflictsIn<
  A extends {
    starts_at: string;
    ends_at: string;
    staff_user_id: string | null;
    service_id: string;
  },
>(
  appointments: readonly A[],
  rowIds: ReadonlySet<string>,
  range: { start: Date; end: Date },
  resources: readonly ResourceLike[],
  serviceResources: readonly { service_id: string; counter_id: string }[],
): A[] {
  return appointments.filter(
    (a) =>
      rowIds.has(rowForAppointment(a, resources, serviceResources)) &&
      new Date(a.starts_at) < range.end &&
      new Date(a.ends_at) > range.start,
  );
}
