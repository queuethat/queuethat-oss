/**
 * A clock time at the location, e.g. "2:30 PM", for staff and guest screens. Times are shown in
 * the location's time zone, never the device's (I-6): a tablet set to another zone still shows
 * the time on the shop's wall clock.
 */
export function formatLocalTime(at: Date | string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(new Date(at));
}

/** The wall-clock offset of `timeZone` at `at`, in minutes east of UTC. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "HH:mm" on the location's wall clock, the value of a time input (I-6: never the device's zone). */
export function localTimeValue(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at));
}

/**
 * The instant at which the location's wall clock reads `hhmm` ("HH:mm") on the same local day as
 * `sameDayAs`. Corrections move a time within its day, so the day is taken from the original.
 */
export function atLocalTime(hhmm: string, sameDayAs: Date | string, timeZone: string): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(
    new Date(sameDayAs),
  );
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, h!, min!);
  // Two passes settle on the right offset across a daylight-saving change.
  let at = new Date(wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000);
  at = new Date(wall - zoneOffsetMinutes(at, timeZone) * 60_000);
  return at;
}

/**
 * An instant as a `datetime-local` value ("YYYY-MM-DDTHH:mm") on the location's wall clock
 * (I-6: never the browser's zone).
 */
export function localDateTimeValue(at: Date | string, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(
    new Date(at),
  );
  return `${date}T${localTimeValue(at, timeZone)}`;
}

/**
 * The instant at which the location's wall clock reads a `datetime-local` value
 * ("YYYY-MM-DDTHH:mm"). Inverse of `localDateTimeValue`.
 */
export function fromLocalDateTime(value: string, timeZone: string): Date {
  const wall = Date.parse(`${value}:00Z`);
  // Two passes settle on the right offset across a daylight-saving change.
  let at = new Date(wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000);
  at = new Date(wall - zoneOffsetMinutes(at, timeZone) * 60_000);
  return at;
}
