// 2P-RPT4 (#200): export-data. Streams a zip with one CSV or JSON Lines file per table of the
// caller's organization. The ticket comes from api.begin_data_export (role, MFA, rate limit and
// audit are decided there); this function re-reads it as the caller, so only its owner can use it.
// Every read is paged and uses the caller's JWT, so RLS still applies (technical-design.md 3.5).
//
// POST { export_id }   Authorization: Bearer <user JWT>
//   200 application/zip   400 invalid_input · 401 not_authenticated · 404 not_found · 410 expired
// Logs carry fixed words and ids only: never a row value.
import { Zip, ZipDeflate } from 'fflate';

export type Row = Record<string, unknown>;
export interface Ticket {
  org_id: string;
  format: 'csv' | 'jsonl';
  expires_at: string;
}

export interface ExportDeps {
  /** The caller's ticket, read under RLS; null when it is not theirs or does not exist. */
  ticket(jwt: string, exportId: string): Promise<Ticket | null>;
  /** Up to `limit` of the org's rows from `table` with id above `after`, in id order, as the caller. */
  page(jwt: string, table: string, orgId: string, after: string | number | null, limit: number, columns?: string): Promise<Row[]>;
  log?(line: string, cause: unknown): void;
}

/**
 * Tables exported, in order. Where the app hides columns from signed-in users (token hashes,
 * idempotency keys), the list names the readable ones; everything else is `*`.
 */
export const TABLES: { name: string; columns?: string }[] = [
  { name: 'organizations' },
  { name: 'locations' },
  { name: 'queues' },
  { name: 'services' },
  { name: 'counters' },
  {
    name: 'visits',
    columns:
      'id,org_id,location_id,queue_id,service_id,service_day,ticket_prefix,ticket_number,display_ticket,status,sort_key,party_size,guest_name,guest_id,contact_id,locale,source,counter_id,assigned_staff_id,call_count,eta_quoted_low,eta_quoted_high,joined_at,called_at,serving_at,finished_at,version,guest_phone_e164,guest_email,assigned_counter_id,group_key,notes,tags,scheduled_at',
  },
  { name: 'visit_events' },
  {
    name: 'appointments',
    columns:
      'id,org_id,location_id,service_id,queue_id,staff_user_id,starts_at,ends_at,local_date,status,guest_name,guest_id,contact_id,source,visit_id,version,cancelled_reason,created_at,guest_phone_e164,guest_email,locale',
  },
  { name: 'guests' },
  { name: 'guest_contacts' },
  { name: 'consents' },
  {
    name: 'notifications',
    columns:
      'id,org_id,visit_id,event_id,channel,recipient_ref,template_key,template_version,category,vars,dedupe_key,consent_id,status,attempts,next_attempt_at,locked_until,provider,provider_message_id,error_code,segments,cost_micros,quiet_hours_deferred,created_at,updated_at,appointment_id,scheduled_for',
  },
  { name: 'notification_templates' },
  { name: 'notification_template_versions' },
  { name: 'audit_log' },
];

const PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** One CSV cell. Text a spreadsheet would run as a formula (guest names are guest-typed) gets a leading apostrophe. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const encoder = new TextEncoder();

function readme(counts: Map<string, { rows: number; columns: string[] }>, format: string): string {
  const lines = [
    'Data export',
    '',
    `Format: ${format === 'csv' ? 'CSV (UTF-8, header row, CRLF line ends)' : 'JSON Lines (UTF-8, one object per line)'}. One file per table.`,
    'Times are UTC (ISO 8601). Empty cells (CSV) and null (JSON) mean no value. Nested values are JSON text.',
    'CSV text that begins with = + - @ has a leading apostrophe so spreadsheets do not run it as a formula.',
    'Token hashes, idempotency keys and device keys are not readable by the app and are left out. Hashes of contact values in consents are included.',
    '',
  ];
  for (const [table, { rows, columns }] of counts)
    lines.push(`${table}: ${rows} rows. Columns: ${columns.join(', ') || '(no rows)'}`);
  return lines.join('\n') + '\n';
}

/** The zip, produced one page at a time so memory stays flat however large the org is. */
function zipStream(deps: ExportDeps, jwt: string, ticket: Ticket, log: (line: string, cause: unknown) => void): ReadableStream<Uint8Array> {
  const out: Uint8Array[] = [];
  let finished = false;
  let failure: unknown = null;
  const zip = new Zip((error, chunk, final) => {
    if (error) failure = error;
    else out.push(chunk);
    if (final) finished = true;
  });
  const ext = ticket.format === 'csv' ? 'csv' : 'jsonl';

  async function* files(): AsyncGenerator<void> {
    const counts = new Map<string, { rows: number; columns: string[] }>();
    for (const table of TABLES) {
      const file = new ZipDeflate(`${table.name}.${ext}`, { level: 6 });
      zip.add(file);
      const stat = { rows: 0, columns: table.columns ? table.columns.split(',') : [] as string[] };
      let after: string | number | null = null;
      for (;;) {
        const rows = await deps.page(jwt, table.name, ticket.org_id, after, PAGE, table.columns);
        if (rows.length > 0 && stat.columns.length === 0) stat.columns = Object.keys(rows[0]);
        if (stat.rows === 0 && ext === 'csv' && stat.columns.length > 0) file.push(encoder.encode(stat.columns.join(',') + '\r\n'));
        const text = rows
          .map((r) => (ext === 'csv' ? stat.columns.map((c) => csvCell(r[c])).join(',') + '\r\n' : JSON.stringify(r) + '\n'))
          .join('');
        stat.rows += rows.length;
        const last = rows.at(-1);
        const done = rows.length < PAGE;
        file.push(encoder.encode(text), done);
        yield;
        if (done || !last) break;
        after = last.id as string | number;
      }
      counts.set(table.name, stat);
    }
    const doc = new ZipDeflate('README.txt', { level: 6 });
    zip.add(doc);
    doc.push(encoder.encode(readme(counts, ticket.format)), true);
    zip.end();
    yield;
  }

  const steps = files();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (out.length === 0 && !finished) {
          if ((await steps.next()).done) break;
        }
        if (failure) throw failure;
        for (const chunk of out.splice(0)) controller.enqueue(chunk);
        if (finished && out.length === 0) controller.close();
      } catch (error) {
        log(`export for org ${ticket.org_id} failed`, error);
        controller.error(error);
      }
    },
  });
}

export function createExportHandler(deps: ExportDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});

  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });

    const jwt = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!jwt) return json(401, { error: 'not_authenticated' });
    const body = await req.json().catch(() => null);
    const id = body && typeof body.export_id === 'string' ? body.export_id : '';
    if (!UUID.test(id)) return json(400, { error: 'invalid_input' });

    let ticket: Ticket | null;
    try {
      ticket = await deps.ticket(jwt, id);
    } catch (error) {
      log(`reading export ticket ${id} failed`, error);
      return json(500, { error: 'unknown' });
    }
    if (!ticket) return json(404, { error: 'not_found' });
    if (Date.parse(ticket.expires_at) <= Date.now()) return json(410, { error: 'expired' });

    const day = new Date().toISOString().slice(0, 10);
    return new Response(zipStream(deps, jwt, ticket, log), {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="export-${day}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  };
}
