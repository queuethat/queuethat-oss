# Observability

O6 (#77). These tools let the maintainer find out about lost entries, crashes and stuck jobs: errors, uptime
and job health reach a phone. Every tool here is on a free tier.

## Error reports (Sentry or GlitchTip)

The web app sends uncaught errors and unhandled promise rejections when `VITE_SENTRY_DSN` is set
at build time. Without it, nothing is sent and the SDK is never downloaded.

- **What leaves the browser.** No free text. A guest's name can't be recognised by any pattern,
  so `scrubEvent` in `apps/web/src/lib/sentry.ts` (#530) sends:
  - each exception's type and stack, with its message replaced by the database error code
    (`rate_limited`, …) when there is one and `[message]` otherwise;
  - no `captureMessage` text, log entry or extra data (where a thrown plain object's fields go);
  - breadcrumbs reduced to kind, time, method, status and path (no query, no message);
  - the page path without its query.

  Everything else in the event still passes through `redactDeep` from `@qm/domain`, which
  replaces emails, phone numbers, JWTs, guest link tokens (`/v/<token>`), secret URL parameters
  and the values of contact, token and credential keys at any depth. User info (so no IP
  inference), cookies, headers, request bodies, console and DOM breadcrumbs are all off. To
  debug, read the stack and the release; the message text is in the browser console only.
- **Cost to guests.** The SDK (about 30 KB gzip) loads only once the page is idle. It is not
  part of the guest-route JS budget, and errors thrown before it loads are reported once it
  does.
- **CSP.** `connect-src` allows `https://*.sentry.io` in `apps/web/public/_headers` and
  `deploy/selfhost/Caddyfile`. A self-hosted GlitchTip needs its origin added to both. When the
  CSP moves from report-only to enforced, narrow it to the DSN's own ingest host (for example
  `https://o123.ingest.us.sentry.io`).

### Setup checklist

- [ ] Create a Sentry project (platform: Browser JavaScript) or a GlitchTip project. Copy the
      DSN into the build environment as `VITE_SENTRY_DSN`. The DSN is public by design.
- [ ] In the project's security and privacy settings, turn on **Data scrubbing** and
      **Prevent storing of IP addresses**. They back up the client-side scrubbing.
- [ ] Add an alert rule for new issues that sends a push to the Sentry app on the maintainer's phone.
- [ ] Check it: on the deployed site, run `setTimeout(() => { throw new Error('test +447700900123') })`
      in the console. The issue must arrive reading `test [phone]`.
- [ ] Source maps (decision 48): in the build environment only, set `SENTRY_AUTH_TOKEN` (an org
      token with `project:releases`), `SENTRY_ORG` and `SENTRY_PROJECT`, plus `SENTRY_URL` for
      GlitchTip or a self-hosted Sentry. Never prefix them with `VITE_`. `pnpm build` then
      uploads the maps for the build's release (`dist/version.json`, the `release` the app
      reports; set `APP_VERSION` to the git sha to make releases readable). Then it deletes
      every `.map`, so the deploy never serves them.

### Source maps

`vite build` writes hidden maps: there's no `sourceMappingURL` comment in the bundle.
`apps/web/scripts/sourcemaps.mjs` runs next in `pnpm build`. When the three variables above are
set, it runs `@sentry/cli` (an exact devDependency, so the lockfile fixes the whole tree the token
is exposed to; its FSL-1.1-MIT licence has a version-pinned, build-only exception in
`.github/license-policy.json`) to upload `dist/` for
the release, matching files by `~/` URL. It always removes the maps afterwards, and it fails the
build if the upload fails or a bundle still links a map. The token reaches only sentry-cli's
environment, never its command line; that environment also keeps the proxy and CA variables
(`HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, …) so uploads work from a proxied build network. `check-bundle-secrets` fails the build if a Sentry token,
or the literal `SENTRY_AUTH_TOKEN` value, appears in `dist/`. Without a token, builds (local, CI,
self-host) just drop the maps.

### Edge Functions

`dispatch-notifications`, `pair-device` and `unsubscribe` log through `_shared/observe.ts`.
Every line goes through `redactText` before it reaches the function logs. When the
`SENTRY_DSN` secret is set, failures are also reported to Sentry, without free text (#530): a
report carries the caller's fixed line (words and ids, such as `outbox 7 sms error`) or an
exception's type and stack. The thrown value's text, which can echo a rendered message with a
guest's name, goes to the function logs only. They stay in our Supabase project, which already
holds the data, with short retention. A log drain to a third party needs the same no-free-text
rule first. Failures that are reported:

- dispatch errors;
- pairing failures;
- unsubscribe failures;
- anything a handler throws. The caller gets a bare `500 {"error":"unknown"}`.

Reports are scrubbed with `redactDeep` and flushed before the response returns. The SDK
(`npm:@sentry/deno`) loads only when the secret is set, with its default integrations off,
because the Edge Runtime lacks the APIs they patch.

- [ ] Run `supabase secrets set SENTRY_DSN=<dsn>`. A separate Sentry project (platform: Deno)
      keeps server errors apart from browser ones.

## Health check and uptime (UptimeRobot)

The `health` Edge Function (`GET /functions/v1/health`, no key needed) answers `200
{"status":"ok"}`, or `503 {"status":"failing","failing":[...]}` naming the checks that failed:

| Check        | Fails when                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| `database`   | `api.health_report()` can't be read                                         |
| `rollover`   | the `rollover-tick` pg_cron job hasn't succeeded for 15 minutes             |
| `dispatcher` | the `kick-dispatcher` pg_cron job hasn't succeeded for 2 minutes            |
| `outbox`     | a notification has been due for over 10 minutes (sends are stuck or failing) |

These checks are the heartbeats for the two jobs that lose guests when they stop. Rollover closes
yesterday's line, and the dispatcher sends "you're up". The limits live in
`supabase/functions/health/handler.ts`. The response carries no ids, counts or tenant data.

The endpoint needs no key, so anyone can call it. Each function instance reuses one answer for 20
seconds, so a flood costs a database read per window rather than one per request. Every call
still counts against the Supabase Free plan's 500k Edge Function invocations a month. A 5-minute
monitor uses about 9k of them.

- [ ] In UptimeRobot (free), add an HTTP(S) monitor for
      `https://<ref>.supabase.co/functions/v1/health` at a 5-minute interval, alerting through
      the UptimeRobot app on the maintainer's phone. Add a second monitor for the web app's `/`.
- [ ] Check it: the monitor is green, and the response is `{"status":"ok"}`.

## Heartbeats for jobs outside the database (Healthchecks.io)

Healthchecks.io (free) alerts when an expected ping doesn't arrive. Use it for jobs that run
outside Postgres and can't show up in `health`. The self-host backup job is one ([backups](../selfhost/backups.md), `BACKUP_HEALTHCHECK_URL`):
it pings on success and `/fail` on failure, and each check's period matches its schedule plus
some grace.

- [ ] Create one check per external job, alerting through the Healthchecks.io app or email.
