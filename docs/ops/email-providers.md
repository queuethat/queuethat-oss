# Email providers

Queue email goes through a `NotificationChannel` of kind `email` (I-11). Adapters live in
`packages/providers/src/email/` and pass `runChannelContract` against recorded fixtures
(`tests/fixtures/providers/email/`). No live account is needed to run or merge them.

| Provider | Adapter                | Idempotency                         | Local            |
| -------- | ---------------------- | ----------------------------------- | ---------------- |
| Mailpit  | `mailpitEmailChannel`  | none                                | `pnpm db:start`  |
| Postmark | `postmarkEmailChannel` | `Metadata.outbox_id` (no real key)  | fixtures only    |
| Resend   | `resendEmailChannel`   | `Idempotency-Key: <outbox id>`      | fixtures only    |

Failure mapping (same for both): 2xx sent; 429, 409 and 5xx or a network error retryable; 401/403
never retried (the key is wrong); 422 for a bad address is `invalid_recipient`; other 4xx are
non-retryable `http_<status>`. Failure messages never contain the API key.

From and Reply-To are constructor options. The registry (#341) fills them from the org's settings,
so mail carries the org's real sending identity (CAN-SPAM). `List-Unsubscribe` is sent only for
https URLs.

## SES

**Gap versus the ticket:** #347 says SES works through "the phase 1 SMTP channel". No such channel
exists in `packages/providers` (auth mail uses Supabase's own SMTP; the dispatcher sends through
Mailpit's HTTP API), and hosted Edge Functions cannot open ports 25/465/587. So `ses_smtp` is
not mapped yet. Options: an SES HTTP (SigV4) adapter, which the ticket puts out of scope, or run
the dispatcher where outbound SMTP is allowed. Left on the #398 decision list.

For Supabase **auth** mail only, SES SMTP settings are: host `email-smtp.<region>.amazonaws.com`,
port 587 (STARTTLS), SMTP username/password generated in the SES console (not IAM keys), and a
verified sending domain.

## Sandbox runs

Real-provider runs are optional and skipped without keys; nothing in CI needs them.
