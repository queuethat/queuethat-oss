# @qm/error-reporting

The scrubbed Sentry setup shared by every browser app (tenant app, operator console). One owner for
the rule that no free text, contact data, guest token or credential leaves the browser (I-7, I-13):
an app supplies its DSN, release and a loader for its own `@sentry/browser` re-exports, and gets
errors only (no replay, tracing, console or DOM capture).

**Rules**

- Import only types from `@sentry/browser` here. The app owns the runtime import (its
  `sentry-sdk.ts`), so named re-exports let the bundler drop replay and feedback.
- Never add a way to send free text or user info. Loosening a scrubber needs a security review.
