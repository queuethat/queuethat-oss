// Event times: the database stores a `tstzrange`; admins type wall-clock times of the location.

/** The instant (ISO) at which `local` (`YYYY-MM-DDTHH:mm`) reads on the wall clock of `tz`. */
export function wallToInstant(local: string, tz: string): string {
  const asUtc = Date.parse(`${local}:00Z`);
  let guess = asUtc;
  // Two passes settle the offset, including across a daylight-saving change.
  for (let i = 0; i < 2; i++) guess = asUtc - offsetMs(guess, tz);
  return new Date(guess).toISOString();
}

/** `YYYY-MM-DDTHH:mm` of an instant on the wall clock of `tz`, for a datetime-local field. */
export function instantToWall(instant: string, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function offsetMs(instant: number, tz: string): number {
  return Date.parse(`${instantToWall(new Date(instant).toISOString(), tz)}:00Z`) - instant;
}

/** PostgREST renders a tstzrange as `["2030-01-12 10:00:00+00","2030-01-12 11:00:00+00")`. */
export function parseRange(range: string): { start: string; end: string } {
  const [start, end] = [...range.matchAll(/"([^"]+)"/g)].map((m) => new Date(m[1]!).toISOString());
  return { start: start!, end: end! };
}

/** The `[start,end)` text PostgREST accepts for a tstzrange. */
export function formatRange(start: string, end: string): string {
  return `[${start},${end})`;
}
