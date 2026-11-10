// 4-AI1 (#394): ask-analytics. A manager asks a question in plain language; the model turns it into a
// report definition over the fixed metric catalogue, the database validates and runs it as the caller,
// and the model may then summarise the aggregate numbers. An Edge Function because only it makes outbound
// calls with the org's own API key (technical-design.md 3.5, rule 3).
//
// The model never writes SQL and never sees guest data: its first prompt holds the catalogue and the
// question, its second only the aggregate rows. Questions that look like they contain contact details are
// refused before anything leaves the system.
//
// POST { org_id, location_id?, question, summarize? }   Authorization: Bearer <staff JWT>
//   200 { definition: {measures, dimensions, from, to}, rows, summary, remaining }
//   400 invalid_input   401 not_authenticated   403 permission_denied   404 not_found
//   409 analytics_disabled   422 couldnt_answer (the reply was not a valid definition; nothing ran)
//   429 rate_limited   502 llm_unavailable   500 unknown
import { LlmError, type LlmProvider } from '@qm/providers';

export interface ReportRow {
  dims: Record<string, string | number>;
  measures: Record<string, number | null>;
}

/** A refusal carrying the database's error code. */
export class DbError extends Error {}

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
}

export interface AskDeps {
  /** api.ask_analytics_reserve as the caller: checks role, opt-in and cap, logs the question. Returns the questions left today. */
  reserve(jwt: string, orgId: string, question: string): Promise<number>;
  /** api.get_channel_config(org, 'llm') as the service role. Null when the channel is off. */
  llmConfig(orgId: string): Promise<LlmConfig | null>;
  /** api.run_report as the caller, so the database applies the caller's role and tenant. */
  runReport(jwt: string, definition: unknown, from: string, to: string): Promise<ReportRow[]>;
  makeProvider(config: LlmConfig): LlmProvider;
  /** Today's date as YYYY-MM-DD (UTC); injected so tests do not depend on the clock. */
  today(): string;
  /** PUBLIC_URL: the only browser origin allowed. */
  publicUrl: string;
  error?(line: string, cause: unknown): void;
}

// What the model is told. The database is the validator; this list only steers the model.
const MEASURES: Record<string, string> = {
  visits: 'number of visits',
  served: 'visits that were served',
  avg_wait_min: 'average minutes from joining to being called',
  avg_service_min: 'average minutes of service',
  no_show_pct: 'percent of visits that were no-shows',
  eta_error_min: 'average minutes the wait fell outside the quoted ETA range',
};
const DIMENSIONS: Record<string, string> = {
  service_day: 'calendar day',
  hour: 'hour of day the guest joined',
  weekday: 'day of week, 1 = Monday',
  service: 'service name',
  queue: 'queue name',
  location: 'location name',
  counter: 'counter name',
};
const MAX_DAYS = 365;
const MAX_ROWS_TO_MODEL = 100;

const SYSTEM = `You turn a business manager's question about their queue into a JSON report definition.
Reply with one JSON object and nothing else: {"measures": [...], "dimensions": [...], "days": N}.
measures (1 to 6 of): ${JSON.stringify(MEASURES)}
dimensions (0 to 3 of): ${JSON.stringify(DIMENSIONS)}
days: how many days back from today to include, 1 to ${MAX_DAYS}.
If the question cannot be answered with these, reply {"error": "cannot_answer"}.`;

const SUMMARY_SYSTEM =
  `You summarise aggregate queue statistics for a manager in at most three plain sentences. The numbers are all you know; do not guess causes you cannot see in them.`;

/** Contact details in a question would be sent to a third party, so they are refused. */
const looksLikeContact = (q: string) => /\S+@\S+/.test(q) || /\d[\d\s().-]{6,}\d/.test(q);

/** Pulls the first JSON object out of a model reply (models like to wrap it in prose or fences). */
function parseObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The model's definition if every name is in the catalogue, else null. */
function validDefinition(
  reply: Record<string, unknown> | null,
): { measures: string[]; dimensions: string[]; days: number } | null {
  if (!reply) return null;
  const { measures, dimensions, days } = reply;
  const names = (v: unknown, allowed: Record<string, string>, min: number, max: number) =>
    Array.isArray(v) && v.length >= min && v.length <= max && new Set(v).size === v.length &&
    v.every((x) => typeof x === 'string' && Object.hasOwn(allowed, x));
  if (!names(measures, MEASURES, 1, 6) || !names(dimensions ?? [], DIMENSIONS, 0, 3)) return null;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_DAYS) return null;
  return {
    measures: measures as string[],
    dimensions: (dimensions ?? []) as string[],
    days: days as number,
  };
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_authenticated: 401,
  permission_denied: 403,
  not_found: 404,
  analytics_disabled: 409,
  rate_limited: 429,
  invalid_report_definition: 422,
  range_too_large: 422,
};

export function createAskHandler(deps: AskDeps): (req: Request) => Promise<Response> {
  const log = deps.error ?? (() => {});
  const headers = (origin: string | null) => ({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin === deps.publicUrl ? deps.publicUrl : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  });
  return async (req) => {
    const origin = req.headers.get('origin');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: headers(origin) });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) });
    if (origin !== null && origin !== deps.publicUrl) return json(403, { error: 'forbidden' });
    if (req.method !== 'POST') return json(405, { error: 'invalid_input' });
    const jwt = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!jwt) return json(401, { error: 'not_authenticated' });

    const body = await req.json().catch(() => null);
    const orgId = typeof body?.org_id === 'string' ? body.org_id : '';
    const locationId = typeof body?.location_id === 'string' ? body.location_id : undefined;
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!orgId || question.length < 1 || question.length > 500 || looksLikeContact(question)) {
      return json(400, { error: 'invalid_input' });
    }

    try {
      const remaining = await deps.reserve(jwt, orgId, question);
      const config = await deps.llmConfig(orgId);
      if (!config) return json(409, { error: 'analytics_disabled' });
      const llm = deps.makeProvider(config);

      const reply = await llm.complete({ system: SYSTEM, user: question, maxTokens: 300 });
      const def = validDefinition(parseObject(reply));
      if (!def) return json(422, { error: 'couldnt_answer' });

      const to = deps.today();
      const from = addDays(to, 1 - def.days);
      const rows = await deps.runReport(
        jwt,
        {
          org_id: orgId,
          measures: def.measures,
          dimensions: def.dimensions,
          ...(locationId ? { filters: { location_id: locationId } } : {}),
        },
        from,
        to,
      );

      let summary: string | null = null;
      if (body?.summarize !== false && rows.length > 0) {
        try {
          summary = (await llm.complete({
            system: SUMMARY_SYSTEM,
            user: JSON.stringify({
              question,
              from,
              to,
              rows: rows.slice(0, MAX_ROWS_TO_MODEL),
            }),
            maxTokens: 300,
          })).trim().slice(0, 1000);
        } catch (e) {
          log('ask-analytics summary', e); // the numbers are still worth returning
        }
      }
      return json(200, {
        definition: { measures: def.measures, dimensions: def.dimensions, from, to },
        rows,
        summary,
        remaining,
      });
    } catch (e) {
      if (e instanceof DbError) return json(STATUS[e.message] ?? 500, { error: e.message });
      if (e instanceof LlmError) {
        log('ask-analytics llm', e);
        return json(502, { error: 'llm_unavailable' });
      }
      log('ask-analytics', e);
      return json(500, { error: 'unknown' });
    }
  };
}
