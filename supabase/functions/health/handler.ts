// O6 (#77): the health check UptimeRobot polls. Answers 200 when the database answers and the
// background jobs are keeping up, 503 otherwise, naming the failing checks and nothing else.

/** api.health_report: when each job last succeeded, and the oldest send that is due now. */
export interface HealthReport {
  checked_at: string;
  rollover_ok_at: string | null;
  dispatcher_kick_ok_at: string | null;
  oldest_due_at: string | null;
}

export interface HealthDeps {
  report(): Promise<HealthReport>;
  error?(line: string, cause: unknown): void;
  /** Clock for the cache; tests pass a fake. */
  now?(): number;
}

/**
 * How long one answer is reused. The endpoint is public, so a flood of requests costs one
 * database read per window, not one each; concurrent requests share the read in flight.
 */
export const CACHE_MS = 20_000;

/** How stale each signal may get. Rollover ticks every 5 min and the kick every 15 s. */
export const LIMITS = {
  rolloverSeconds: 15 * 60,
  dispatcherKickSeconds: 2 * 60,
  oldestDueSeconds: 10 * 60,
};

export type Check = 'database' | 'rollover' | 'dispatcher' | 'outbox';

/** The checks `report` fails, judged against its own `checked_at` (database time). */
export function failingChecks(report: HealthReport): Check[] {
  const now = Date.parse(report.checked_at);
  const age = (at: string | null) => (at === null ? Infinity : (now - Date.parse(at)) / 1000);
  const failing: Check[] = [];
  if (age(report.rollover_ok_at) > LIMITS.rolloverSeconds) failing.push('rollover');
  if (age(report.dispatcher_kick_ok_at) > LIMITS.dispatcherKickSeconds) failing.push('dispatcher');
  if (report.oldest_due_at !== null && age(report.oldest_due_at) > LIMITS.oldestDueSeconds) {
    failing.push('outbox');
  }
  return failing;
}

/**
 * GET (or HEAD) only. 200 `{status: "ok"}`, or 503 `{status: "failing", failing: [...]}`, where
 * `database` means the report itself could not be read. Reused for `CACHE_MS` inside the
 * function; never cached by browsers or proxies (`no-store`).
 */
export function createHealthHandler(deps: HealthDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  let cached: { until: number; failing: Promise<Check[]> } | undefined;
  const evaluate = async (): Promise<Check[]> => {
    try {
      return failingChecks(await deps.report());
    } catch (error) {
      deps.error?.('health report failed', error);
      return ['database'];
    }
  };
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'invalid_input' });
    const at = now();
    if (!cached || at >= cached.until) cached = { until: at + CACHE_MS, failing: evaluate() };
    const failing = await cached.failing;
    return failing.length === 0
      ? json(200, { status: 'ok' })
      : json(503, { status: 'failing', failing });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
