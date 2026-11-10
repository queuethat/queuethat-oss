/**
 * A moment as the location's own clock shows it (I-6): the time, and the weekday when it is not
 * today there. Callers put these in their sentences.
 */
export function localWhen(
  iso: string,
  now: number,
  tz: string,
  locale: string,
): { time: string; day: string | null } {
  const dayOf = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(at);
  if (dayOf(at.getTime()) === dayOf(now)) return { time, day: null };
  return {
    time,
    day: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: tz }).format(at),
  };
}
