import type { ConsoleVisit } from '../api.ts';

/** A visit placed on today's timeline: appointments at their time, walk-ins at when they joined. */
export interface TimelineEntry {
  visit: ConsoleVisit;
  /** The instant it is placed at (ISO). */
  at: string;
  /** Minutes after midnight on the location's wall clock. */
  minute: number;
}

const FIRST_HOUR = 8;
const LAST_HOUR = 18;

function parts(iso: string | number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/** Minutes after midnight at the location (I-6: never the device's zone). */
export const localMinute = (at: string | number, timeZone: string) => parts(at, timeZone).minute;

/**
 * Today's visits at the location, in time order. Expected visits sit at `scheduledAt`, everyone
 * else at `joinedAt` (the console's `since` for a waiting visit); finished visits are not here.
 */
export function timelineEntries(
  visits: ConsoleVisit[],
  timeZone: string,
  now: number,
): TimelineEntry[] {
  const today = parts(now, timeZone).date;
  return visits
    .map((visit) => ({ visit, at: visit.scheduledAt ?? visit.joinedAt }))
    .filter(({ at }) => parts(at, timeZone).date === today)
    .map(({ visit, at }) => ({ visit, at, minute: parts(at, timeZone).minute }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The hours to draw: the working day, widened to hold every entry and the current time. */
export function hourRange(entries: TimelineEntry[], nowMinute: number): number[] {
  const hours = [...entries.map((e) => Math.floor(e.minute / 60)), Math.floor(nowMinute / 60)];
  const first = Math.min(FIRST_HOUR, ...hours);
  const last = Math.max(LAST_HOUR, ...hours);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
