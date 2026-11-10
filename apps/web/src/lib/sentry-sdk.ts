// The only parts of @sentry/browser the app loads. Importing the package's namespace pulls in
// replay and feedback too (~140 KB gzip); named re-exports let the bundler drop them.
export { breadcrumbsIntegration, captureException, init } from '@sentry/browser';
