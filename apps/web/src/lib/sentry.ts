import { sentryOptions as shared, startErrorReporting as start } from '@qm/error-reporting';
import { APP_VERSION } from '../features/device/version.ts';
import { appConfig } from './config.ts';
import { rememberErrorId } from './lastError.ts';
import type * as Sdk from './sentry-sdk.ts';

export { scrubBreadcrumb, scrubEvent } from '@qm/error-reporting';

const app = {
  release: APP_VERSION,
  environment: import.meta.env.MODE,
  onSent: rememberErrorId,
};

/** The shared scrubbed Sentry options, with this app's release and last-error id. */
export function sentryOptions(sdk: Pick<typeof Sdk, 'breadcrumbsIntegration'>, dsn: string) {
  return shared(sdk, dsn, app);
}

/** Starts error reporting when `VITE_SENTRY_DSN` is set, and otherwise does nothing. */
export function startErrorReporting(dsn = appConfig().sentryDsn): void {
  start(dsn, app, () => import('./sentry-sdk.ts'));
}
