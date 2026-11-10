/** What an .ics event needs. Times are instants; the calendar shows them in the viewer's zone. */
export interface IcsEvent {
  /** Stable across downloads, so importing twice updates the event instead of duplicating it. */
  uid: string;
  /** ISO 8601 instant. */
  start: string;
  /** Event length; a visit has no fixed one, so callers pass a default. */
  durationMinutes: number;
  summary: string;
  location?: string | null;
  description?: string | null;
  /** Minutes before the start for the reminder; none when omitted. */
  alarmMinutes?: number;
  /** When the file was made (ISO); defaults to now. Injectable for tests. */
  stamp?: string;
}

/** `2026-11-03T13:30:00Z` as `20261103T133000Z`. */
function utc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`not a date: ${iso}`);
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** RFC 5545 3.3.11: backslash, semicolon, comma and newlines are escaped in text values. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTF-8 length of one character (a code point), without needing TextEncoder. */
function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0)!;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Folds a content line to 75 octets, continuation lines starting with one space (RFC 5545 3.1). */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = utf8Length(ch);
    if (bytes + n > limit) {
      out.push(current);
      current = ' ';
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join('\r\n');
}

/**
 * A one-event iCalendar file (RFC 5545), CRLF line endings, UTC times. Built in the browser, so
 * no token or server round trip is involved (G-8).
 */
export function buildIcs(event: IcsEvent): string {
  const start = new Date(event.start);
  const end = new Date(start.getTime() + event.durationMinutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//queue-management//visit//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${utc(event.stamp ?? new Date().toISOString())}`,
    `DTSTART:${utc(event.start)}`,
    `DTEND:${utc(end.toISOString())}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.alarmMinutes != null) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(event.summary)}`,
      `TRIGGER:-PT${event.alarmMinutes}M`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
