import { redactText, withoutFreeText, withoutQuery } from '@qm/domain';
import type {
  Breadcrumb,
  BrowserOptions,
  EventHint,
  ErrorEvent as ReportedError,
} from '@sentry/browser';
import { APP_VERSION } from '../features/device/version.ts';
import { appConfig } from './config.ts';
import { rememberErrorId } from './lastError.ts';

type SentrySdk = Pick<typeof import('./sentry-sdk.ts'), 'breadcrumbsIntegration'>;

/** A URL or path with its query and fragment removed, then scrubbed. */
function pathOnly(url: unknown): string | undefined {
  return typeof url === 'string' ? redactText(withoutQuery(url)) : undefined;
}

/**
 * The event as it may leave the browser: no free text (`withoutFreeText`, #530), no
 * `captureMessage` text, request URL without its query, breadcrumbs as `scrubBreadcrumb` leaves
 * them.
 */
export function scrubEvent(event: ReportedError, hint?: EventHint): ReportedError {
  const { message: _message, ...rest } = withoutFreeText(event, hint?.originalException);
  if (rest.request?.url) rest.request.url = pathOnly(rest.request.url);
  if (rest.breadcrumbs) rest.breadcrumbs = rest.breadcrumbs.map(scrubBreadcrumb);
  return rest;
}

/**
 * A breadcrumb reduced to its kind, time and, for navigation and requests, method, status and
 * path. Its message and any other data are dropped: they are free text (#530).
 */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const data = crumb.data ?? {};
  const kept = {
    method: typeof data.method === 'string' ? data.method : undefined,
    status_code: typeof data.status_code === 'number' ? data.status_code : undefined,
    url: pathOnly(data.url),
    from: pathOnly(data.from),
    to: pathOnly(data.to),
  };
  return {
    type: crumb.type,
    category: crumb.category,
    level: crumb.level,
    timestamp: crumb.timestamp,
    data: Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)),
  };
}

/**
 * Sentry options for this app: no free text leaves the browser (see `scrubEvent`), the rest of
 * every event is scrubbed of contact data, guest link tokens and credentials (I-7, I-13), and
 * there is no replay, tracing, console or DOM capture. Exported for tests; `startErrorReporting`
 * is the entry point.
 */
export function sentryOptions(sdk: SentrySdk, dsn: string): BrowserOptions {
  return {
    dsn,
    release: APP_VERSION,
    environment: import.meta.env.MODE,
    // SDK 11 collects user info (so Sentry infers the IP), cookies, headers and query strings
    // unless told otherwise. Guests' IPs are personal data, and the rest can carry tokens.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    // Console and DOM breadcrumbs can carry guest names off staff screens. Navigation and fetch
    // breadcrumbs stay, reduced to method, status and path.
    integrations: (defaults) =>
      defaults
        .filter((integration) => integration.name !== 'Console')
        .map((integration) =>
          integration.name === 'Breadcrumbs'
            ? sdk.breadcrumbsIntegration({ dom: false })
            : integration,
        ),
    beforeSend: (event, hint) => {
      const scrubbed = scrubEvent(event, hint);
      rememberErrorId(scrubbed.event_id);
      return scrubbed;
    },
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

/**
 * Starts error reporting when `VITE_SENTRY_DSN` is set, and otherwise does nothing. The SDK
 * loads once the page is idle, so it never counts against the guest JS budget; errors thrown
 * before then are kept and reported once it has loaded.
 */
export function startErrorReporting(dsn = appConfig().sentryDsn): void {
  if (!dsn) return;
  const early: unknown[] = [];
  const onError = (event: ErrorEvent) => early.push(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => early.push(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  const load = async () => {
    const sdk = await import('./sentry-sdk.ts');
    sdk.init(sentryOptions(sdk, dsn));
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    for (const error of early) sdk.captureException(error);
  };
  const whenIdle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 2000));
  whenIdle(() => void load());
}
