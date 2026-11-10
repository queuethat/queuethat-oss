# Platform Twilio (QueueThat-owned SMS sender)

Hosted QueueThat sends guest texts from **one Twilio sender owned by the platform**, for orgs whose SMS
provider is `twilio` in mode `platform`. Self-hosters keep bringing their own Twilio ([10dlc-runbook.md](10dlc-runbook.md)).
Account steps and registration text: `plans/twilio-platform-setup.md` in the project files.

## Turn it on (operator, after Twilio approves the number)

1. Set Edge Function secrets for `dispatch-notifications` (never in `apps/web`):
   `TWILIO_PLATFORM_ACCOUNT_SID`, `TWILIO_PLATFORM_AUTH_TOKEN`, `TWILIO_PLATFORM_MESSAGING_SERVICE_SID`.
   Prefer a restricted API key: also set `TWILIO_PLATFORM_API_KEY_SID` (`SK...`) and put the **key's secret** in
   `TWILIO_PLATFORM_AUTH_TOKEN`. Set `LOCAL_PROVIDERS_ONLY=false`.
2. In SQL, once: `update private.deployment_settings set platform_messaging_enabled = true;` and
   `update app.platform_flags set compliance_gate_passed_at = now(), hosted_legal_reviewed_at = now();`
   Platform SMS also requires `billing_enabled = true` (nobody is charged otherwise), and setting
   `platform_messaging_enabled` back to false stops every org already enabled.
3. An owner then picks "QueueThat sends for me" (provider `twilio`, mode `platform`) and enables SMS.

Saving platform-mode `sms`/`twilio` marks the setting verified and gives it the platform campaign
(`messaging_campaign_ref = 'platform'`). Switching to the org's own credentials clears both. No org can
store `platform` as its own campaign. Every other gate still applies when SMS is enabled and on each send:
paid plan (`paid_channels`), country allowlist, daily cap and monthly budget, prepaid credit while billing is on
(`api.reserve_send`), consent, suppression and quiet hours.

## Metering

Each sent message records segments and cost on `app.notifications`; `api.usage_summary` reads them per day, and
platform-mode orgs are debited cost plus `sms_margin_bps` from the credit ledger ([billing.md](billing.md)).

## Delivery reports and STOP/START

The platform number has no org in its webhook route, so it uses one fixed route:
`{PUBLIC_FUNCTIONS_URL}/provider-webhook/twilio-platform/{TWILIO_PLATFORM_WEBHOOK_ENDPOINT}`.

1. Generate a random UUID and set `TWILIO_PLATFORM_WEBHOOK_ENDPOINT` on **both** `dispatch-notifications`
   (it asks Twilio to post delivery reports there) and `provider-webhook`.
2. Set `TWILIO_PLATFORM_WEBHOOK_TOKEN` on `provider-webhook` only. Twilio signs webhooks with the account's
   **auth token** (an API key's secret does not sign), so use the *secondary* auth token and rotate it when needed.
3. In the Messaging Service, set the inbound request URL (Integration > "Send a webhook") to the same route.

Delivery reports are applied to the platform-mode org that owns the message (`api.apply_platform_sms_event`).
Advanced Opt-Out STOP/START (`OptOutType`) is sender-level, so a STOP suppresses the number for every
platform-mode SMS org and a START lifts only those stops. HELP is answered by Twilio. Other texts to the number
(for example `L` or `C`) are ignored: a shared number cannot tell which org they mean.

## Follow-ups

- A small included monthly SMS allowance for paid plans (today a paid org must top up prepaid credit before its first text).

## Auto-pause (#1155)

Every 5 minutes `ops.pause_unhealthy_platform_sms` scores each business that sends through the shared number over
its last 24 hours. With at least 30 texts sent it pauses the business when STOP replies reach 5% of sent (and at least 3 distinct numbers),
carrier-filtered (Twilio 30007) 5%, or undelivered/failed 25% (unreachable handsets 30003/30005/30006 are not
counted). `api.reserve_send` then answers `paused` and nothing reaches Twilio. A pause is lifted only by an operator:
/platform, business page, "Platform text messages" (reason required, audited). A resume also stops the job from
re-pausing that business for 24 hours. Thresholds live in `private.platform_sms_threshold` (used by `private.platform_sms_breach` and the 60% `private.platform_sms_warning`). Auto-pauses show in
`app.platform_audit` as `sms.auto_pause`; the org's owners and admins and every platform operator are emailed (`sms_paused`, `sms_paused_operator`). Operators also get a warning email (`sms_warning_operator`) once per business, metric and day when a business reaches 60% of a threshold, and a daily digest at 13:35 UTC (`sms_digest_operator`, from `app.platform_sms_daily`). A rival can still trigger a pause with a few numbers, so check the audit log before resuming.
