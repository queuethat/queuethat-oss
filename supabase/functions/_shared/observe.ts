// O6 (#77): logging and error reports for Edge Functions. Every line and report passes through
// the same redaction as the web app's (@qm/domain), so contact data and tokens never reach the
// function logs or Sentry (I-7, I-13). Free text, which can hold a bare name, reaches the logs
// only: Sentry gets the caller's fixed line and exception types and stacks (#530).
import { redactText, withoutFreeText } from '@qm/domain';
import { logError, logInfo } from './log.ts';

/** The slice of @sentry/deno this module uses, so tests can pass a fake. */
export interface ErrorSink {
  captureMessage(message: string): void;
  captureException(error: unknown): void;
  flush(timeoutMs: number): Promise<boolean>;
}

export interface Observer {
  /** Logs a redacted line. */
  log(line: string): void;
  /**
   * Logs `line` and `cause`, redacted, and reports `line` alone to Sentry when a DSN is set.
   * `line` must hold only fixed words and ids; anything a guest or provider wrote goes in `cause`.
   */
  error(line: string, cause?: unknown): void;
  /**
   * Wraps a `Deno.serve` handler: an uncaught throw is reported and answered with a bare 500,
   * and reports are flushed before the response goes out, because the worker may stop after it.
   */
  serve(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response>;
}

/**
 * The observer for one function. With `dsn` unset, reports go nowhere and nothing is loaded.
 * `load` defaults to importing @sentry/deno; tests pass a fake.
 */
/** Longest line written or reported. Capped after redaction, so a cut never splits a value. */
const MAX_LINE = 500;
const clean = (line: string) => redactText(line).slice(0, MAX_LINE);

/** A thrown value as text; a plain object as JSON rather than `[object Object]`. */
function describe(cause: unknown): string {
  if (cause instanceof Error || typeof cause !== 'object' || cause === null) return String(cause);
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function createObserver(
  name: string,
  dsn: string | undefined,
  load: (dsn: string) => Promise<ErrorSink> = loadSentry,
): Observer {
  // A loader that fails (bad DSN, no network) means no reporting, never a failed request.
  const sink = dsn ? load(dsn).catch(() => undefined) : undefined;
  const pending = new Set<Promise<unknown>>();
  const report = (send: (s: ErrorSink) => void) => {
    if (!sink) return;
    const p = sink.then((s) => s && send(s)).catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  const flush = async () => {
    const s = await sink;
    if (!s) return;
    await Promise.all(pending);
    await s.flush(2000).catch(() => false);
  };

  return {
    log: (line) => logInfo(line),
    error: (line, cause) => {
      logError(cause === undefined ? line : `${line}: ${describe(cause)}`);
      report((s) => s.captureMessage(`${name}: ${clean(line)}`));
    },
    serve: (handler) => async (req) => {
      let response: Response;
      try {
        response = await handler(req);
      } catch (error) {
        logError(`${name}: uncaught ${String(error)}`);
        report((s) => s.captureException(error));
        response = new Response(JSON.stringify({ error: 'unknown' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      await flush();
      return response;
    },
  };
}

async function loadSentry(dsn: string): Promise<ErrorSink> {
  const Sentry = await import('npm:@sentry/deno@11.7.0');
  Sentry.init({
    dsn,
    // The Supabase Edge Runtime lacks APIs the default integrations patch; reports are explicit.
    defaultIntegrations: false,
    beforeSend: (event, hint) => withoutFreeText(event, hint.originalException),
    beforeBreadcrumb: () => null,
  });
  return Sentry;
}
