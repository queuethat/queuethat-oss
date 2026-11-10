// Add-to-calendar file, built in the browser from what the page already shows: no server data
// beyond the service, place and times (A-6).

/** `20261031T130000Z` */
function stamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** RFC 5545 text escaping. */
function esc(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- control characters have no place in a calendar field
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n')
  );
}

export function appointmentIcs(a: {
  service: string;
  place: string;
  startsAt: string;
  endsAt: string;
  /** Stays the same when the appointment moves, so importing again replaces the old event. */
  uid: string;
  /** When this copy was made; a later copy outranks an earlier one in the same calendar. */
  now?: Date;
}): string {
  const made = (a.now ?? new Date()).toISOString();
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Queue//Appointments//EN',
    'BEGIN:VEVENT',
    // Not the start time: after a reschedule the same UID makes the new file update the old event.
    `UID:${a.uid.replace(/[^\w-]/g, '')}@queuethat`,
    `SEQUENCE:${Math.floor(new Date(made).getTime() / 1000)}`,
    `DTSTAMP:${stamp(made)}`,
    `DTSTART:${stamp(a.startsAt)}`,
    `DTEND:${stamp(a.endsAt)}`,
    `SUMMARY:${esc(a.service)}`,
    `LOCATION:${esc(a.place)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/** A calendar UID for a guest link token: a hash, so the file never carries the token itself. */
export async function appointmentUid(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
