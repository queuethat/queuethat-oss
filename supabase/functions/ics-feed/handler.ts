// 2P-APT15 (#171): the per-staff calendar feed. Calendar apps fetch it with no sign-in, so the secret
// token in the URL is the gate (verify_jwt is off in config.toml). It is an Edge Function because only
// the service role may read api.calendar_feed_events, and because it speaks text/calendar.
//
// GET /ics-feed/<token>.ics
//   200 text/calendar   the member's appointments from 7 days back to 60 days ahead (UTC times)
//   404                 unknown or revoked token, or a malformed path (the same answer for all)
//   429                 more than 30 requests a minute for one token on this instance
//   405                 any other method
// The token never reaches a log line: nothing here logs the URL, and failures log only the status.
export interface FeedRow {
  id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  /** First name; null unless the feed opted in. */
  guest_name: string | null;
  version: number;
}

export interface FeedDeps {
  /** api.calendar_feed_events; null for an unknown or revoked token. */
  events(token: string): Promise<FeedRow[] | null>;
  /** Service names by id (service-role read of app.services). */
  serviceNames(ids: string[]): Promise<Map<string, string>>;
  now?(): number;
  error?(line: string, cause: unknown): void;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LIMIT_PER_MINUTE = 30;

/** RFC 5545 TEXT escaping. */
export function escapeText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** Folds a content line at 75 octets, continuing with a space, never splitting a character. */
export function fold(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n ');
}

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildCalendar(rows: FeedRow[], names: Map<string, string>, nowMs: number): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//queue-management//appointments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Appointments',
  ];
  for (const row of rows) {
    const service = names.get(row.service_id) ?? 'Appointment';
    lines.push(
      'BEGIN:VEVENT',
      `UID:appt-${row.id}@queue-management`,
      `DTSTAMP:${stamp(new Date(nowMs).toISOString())}`,
      `DTSTART:${stamp(row.starts_at)}`,
      `DTEND:${stamp(row.ends_at)}`,
      `SEQUENCE:${row.version}`,
      `SUMMARY:${escapeText(row.guest_name ? `${row.guest_name} - ${service}` : service)}`,
      `STATUS:${row.status === 'booked' || row.status === 'checked_in' ? 'CONFIRMED' : 'TENTATIVE'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function plain(status: number): Response {
  return new Response(status === 404 ? 'not found' : status === 429 ? 'slow down' : 'method not allowed', {
    status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export function createFeedHandler(deps: FeedDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const error = deps.error ?? (() => {});
  const hits = new Map<string, number[]>();
  return async (req) => {
    if (req.method !== 'GET') return plain(405);
    const name = new URL(req.url).pathname.split('/').pop() ?? '';
    const token = name.endsWith('.ics') ? name.slice(0, -4) : '';
    if (!TOKEN.test(token)) return plain(404);

    const recent = (hits.get(token) ?? []).filter((t) => t > now() - 60_000);
    if (recent.length >= LIMIT_PER_MINUTE) return plain(429);
    recent.push(now());
    hits.set(token, recent);
    if (hits.size > 5000) {
      // a flood of random tokens must not grow memory; evict the oldest, never reset every budget
      for (const key of hits.keys()) {
        hits.delete(key);
        if (hits.size <= 4000) break;
      }
    }

    try {
      const rows = await deps.events(token);
      if (rows === null) return plain(404);
      const names = await deps.serviceNames([...new Set(rows.map((r) => r.service_id))]);
      return new Response(buildCalendar(rows, names, now()), {
        status: 200,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Cache-Control': 'private, max-age=300',
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch (failure) {
      error('ics-feed failed', failure);
      return plain(404);
    }
  };
}
