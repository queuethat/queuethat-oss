# @qm/providers

`NotificationChannel` and `PaymentProvider` interfaces plus local implementations (console into `dev_inbox`, email into the local Mailpit).

**Rules**

- No runtime dependencies beyond what both Deno and the browser can load. This package is imported by the `dispatch-notifications` Edge Function.
- Relative imports use explicit `.ts` extensions (Deno requires them).
- Every outbound message goes through a `NotificationChannel`; nothing else may send.
- Providers are built with `defineChannel`, which runs `policyCheck` (consent, suppression) before `deliver`. A provider can't skip it.
- Every channel passes `runChannelContract` from `@qm/providers/contract`.

**Adding a provider** (Twilio, Resend, web push...): write `deliver` returning `sent`, `failed` (with `retryable`) or `gone`, wrap it with `defineChannel`, run the contract suite against a fake in CI, and register it in the dispatcher's `createRegistry([...])`. In dev, `consoleChannel({ kind: 'sms', write })` stands in for SMS.

**Quiet hours are the database's.** `api.claim_outbox` (via `private.send_window_open`) never returns a row outside its location's send window, so providers don't re-check it.

**Policy inputs come from the database.** `api.claim_outbox` resolves `has_consent`, `is_suppressed` and `location_tz` per row; the dispatcher copies them into `OutboundMessage.policy`. A push subscription counts as consent, so `claim_outbox` returns `has_consent = true` for push rows.

**Local Mailpit.** `supabase start` runs it at http://127.0.0.1:55324. `MAILPIT_URL=http://127.0.0.1:55324 pnpm test` also runs the contract suite against it.
