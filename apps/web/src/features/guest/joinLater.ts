const STEP_MINUTES = 15;

/** The calendar day of `at` in `timeZone`, as YYYY-MM-DD. */
function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The arrival times a guest can pick when joining for later (J-13): quarter hours from at least
 * 15 minutes ahead, up to `maxHours` ahead, and no later than the end of today at the location.
 * The database decides whether the location is open then and refuses the rest.
 */
export function laterSlots(now: Date, maxHours: number, timeZone: string): Date[] {
  const step = STEP_MINUTES * 60_000;
  const last = now.getTime() + maxHours * 3_600_000;
  const day = localDay(now, timeZone);
  const slots: Date[] = [];
  for (let at = Math.ceil((now.getTime() + step) / step) * step; at <= last; at += step) {
    const slot = new Date(at);
    if (localDay(slot, timeZone) !== day) break;
    slots.push(slot);
  }
  return slots;
}
