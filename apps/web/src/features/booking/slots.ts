// Pure date helpers for the booking screens. Slots are instants; guests read them in the
// location's timezone (the database owns which slots exist, this only groups and words them).

export interface Slot {
  slot_start: string;
  slot_end: string;
  remaining: number;
}

/** `YYYY-MM-DD` of an instant on the wall clock of `tz`. */
export function localDate(instant: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/** Calendar arithmetic on a `YYYY-MM-DD` string; no timezone is involved. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Slots by local date, each day in time order, days in date order. */
export function groupByDay(slots: readonly Slot[], tz: string): Map<string, Slot[]> {
  const days = new Map<string, Slot[]>();
  for (const slot of [...slots].sort((a, b) => a.slot_start.localeCompare(b.slot_start))) {
    const day = localDate(slot.slot_start, tz);
    days.set(day, [...(days.get(day) ?? []), slot]);
  }
  return new Map([...days].sort(([a], [b]) => a.localeCompare(b)));
}

/** "Fri, 31 Oct" for a local date. */
export function formatDay(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** "14:30" on the wall clock of `tz`. */
export function formatTime(instant: string, tz: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(
    new Date(instant),
  );
}

/** "Central European Standard Time" for `tz` at that instant, so a traveller sees whose clock it is. */
export function zoneName(instant: string, tz: string, lang: string): string {
  const parts = new Intl.DateTimeFormat(lang, {
    timeZone: tz,
    timeZoneName: 'long',
  }).formatToParts(new Date(instant));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
}

/** "Friday, 31 October 2026, 14:30" in `tz`. */
export function formatWhen(instant: string, tz: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, {
    timeZone: tz,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(instant));
}
