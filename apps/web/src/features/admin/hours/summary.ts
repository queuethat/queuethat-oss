/** `Intl` only needs a fixed Sunday to name weekdays: 2026-11-01 is a Sunday. */
const SUNDAY = Date.UTC(2026, 10, 1);

/** The weekday's name (0 = Sunday), in the user's language. */
export function weekdayName(weekday: number, locale: string, style: 'short' | 'long' = 'long') {
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(
    SUNDAY + weekday * 86_400_000,
  );
}

/** `HH:MM` as a clock time, "6 pm" or "5:30 pm"; the locale decides 12 or 24 hour. */
export function clockTime(time: string, locale: string) {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return (
    new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: m === 0 ? undefined : '2-digit',
      timeZone: 'UTC',
    })
      .formatToParts(Date.UTC(2026, 10, 1, h, m))
      .map((part) =>
        part.type === 'dayPeriod' ? part.value.toLocaleLowerCase(locale) : part.value,
      )
      .join('')
      // ICU puts a narrow no-break space before am/pm.
      .replace(/\u202f/g, ' ')
  );
}

/** Closing before opening means the interval runs past midnight into the next day. */
export const crossesMidnight = (opens: string, closes: string) => closes < opens;

/**
 * The two ends of an interval in plain language: Fri 18:00-02:00 gives
 * `{ from: 'Fri 6 pm', to: 'Sat 2 am' }`; the end repeats no day when it is the same day.
 */
export function intervalEnds(weekday: number, opens: string, closes: string, locale: string) {
  const day = (d: number) => weekdayName(d % 7, locale, 'short');
  return {
    from: `${day(weekday)} ${clockTime(opens, locale)}`,
    to: crossesMidnight(opens, closes)
      ? `${day(weekday + 1)} ${clockTime(closes, locale)}`
      : clockTime(closes, locale),
  };
}
