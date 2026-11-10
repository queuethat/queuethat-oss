import type { Interval } from '../api.ts';

const DAY = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Most days one "add" may span, so a typo cannot create years of rows. */
export const MAX_RANGE_DAYS = 366;

/** Every calendar date from `from` to `to`, inclusive; empty when `to` is before `from`. */
export function dateRange(from: string, to: string) {
  const dates: string[] = [];
  for (let ms = utc(from); ms <= utc(to) && dates.length <= MAX_RANGE_DAYS; ms += DAY) {
    dates.push(iso(ms));
  }
  return dates;
}

/** Today's calendar date in the location's time zone, `YYYY-MM-DD`. */
export function todayIn(tz: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

/** The date a year after `date`; exceptions beyond it are not listed as upcoming. */
export function yearAfter(date: string) {
  const d = new Date(utc(date));
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return iso(d.getTime());
}

/** Weekday (0 = Sunday) of a calendar date. */
export const weekdayOf = (date: string) => new Date(utc(date)).getUTCDay();

/** "24 Dec", in the user's language; the date has no time zone. */
export function shortDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(utc(date));
}

/** `09:00-13:00, 14:00-18:00` */
export const intervalsText = (intervals: Interval[]) =>
  intervals.map((i) => `${i.opens}-${i.closes}`).join(', ');
