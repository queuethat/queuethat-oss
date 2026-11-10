# Hosted billing (M-1)

Hosted SaaS bills each org per location through the **platform's own** Stripe account (not the org's
BYO keys). Self-host never sees any of it: `app.platform_flags.billing_enabled` is off by default and
every billing trigger, plan default and limit is then a no-op, so everything is free and unlimited.

## Turn it on (deploy runbook)
1. Create a recurring per-unit Price in Stripe (test mode first) and record it:
   `update app.plans set stripe_price_id = 'price_...' where id = 'standard';`
   `app.plans.unit_price_minor` is only the price shown on the billing page; Stripe charges the Price.
   Annual billing (optional): create a second Price on the same Product, per unit, billed yearly
   ($182.40 per location, 20% off twelve months), and record it:
   `update app.plans set stripe_price_id_annual = 'price_...' where id = 'standard';`
   `unit_price_annual_minor` (18240) is the price shown. The Monthly/Annual toggle appears only once the
   annual Price is recorded; the webhook accepts either Price.
2. Set the `billing` Edge Function secrets: `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`,
   `DISPATCH_SECRET`, `PUBLIC_URL` (where Stripe returns the owner, and the only browser origin the portal and checkout routes answer) and `SUPABASE_ANON_KEY`. Test keys only until `BILLING_LIVE=true`. Before any second item (the SMS bundle) joins a subscription, also set `STRIPE_LOCATION_PRICE_IDS` to the monthly and annual per-location Price ids, comma-separated: seat sync then updates only the item carrying one of them. Unset, a subscription must have exactly one item. Locally `BILLING_PROVIDER=fake` with
   `FAKE_BILLING_WEBHOOK_SECRET` works without a Stripe account.
3. Point a Stripe webhook at `{functions}/billing/webhook` for `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`.
4. Store the Vault secret `billing_jobs_url` = `{functions}/billing/jobs` (the minute cron then posts to it with
   the `dispatcher_key`, like `payment_jobs_url`).
5. `update app.platform_flags set billing_enabled = true;`

## Billing page
`/admin/billing` (owners only, hidden while the flag is off) shows the plan, price per location and next invoice.
**Manage billing** opens Stripe's Customer Portal; an org with no subscription sees **Subscribe**, which opens
Stripe Checkout at one seat per location. Both go through `billing/portal` and `billing/checkout`, which pass the
caller's JWT to `api.billing_session_info`; the database decides who is the owner.

## Behaviour
- A subscription's quantity equals the org's locations. Adding or removing a location queues one
  `quantity` sync job; the job reads the count when it runs, so bursts collapse into one Stripe call.
- Stripe is the source of truth. `api.apply_billing_event` applies events in Stripe's order and ignores
  older ones; a customer or subscription belonging to another org is refused.
- A failed payment sets `past_due` with a 14 day grace period. During it the paid plan holds; after it
  (or a cancellation) the org resolves to the `free` plan. **No data is ever deleted.**
- The first move to `past_due` queues a `payment_failed` email to every owner through the outbox (Resend), and
  `ops.send_payment_grace_reminders` (hourly cron) queues `payment_grace_ending` once, four days before the
  grace period ends. Both are idempotent per owner and grace period, and silent while billing is off. Owners also
  see a banner on every admin page (`PastDueBanner`). The emails name `/admin/billing` and, when the dispatcher has `PUBLIC_URL`, link to it
  (`{app_url}`, account mail only; without it the link sentence is dropped).
- Plan defaults for entitlement keys live in `app.plan_entitlements`; an operator override still wins.

## Known limits
- The first link of a subscription to an org trusts the `org_id` in the subscription's metadata, which only
  our own Checkout sets. Keep the platform Stripe account dedicated to this product.
- Stripe event times have one-second resolution; two different events in the same second apply in arrival order.
- `BILLING_PROVIDER=fake` is for local stacks only; never set it where `BILLING_LIVE=true`.

## Free plan limits (M-2)
Limits are plan defaults in the entitlement resolver (`app.plan_entitlements`), so an operator override
(`api.platform_set_entitlement`) always wins. The `free` plan allows 1 location, 3 members (seats, owner
included) and no paid channels (SMS, WhatsApp). `limit.locations` and `limit.members` use `-1` for unlimited.
They are enforced by `BEFORE INSERT` triggers (`plan_limit_reached`) and by the channel-enable gate
(`plan_allows_paid_channels`). Visits are never limited, and nothing a guest reads depends on a limit. A
downgrade keeps every existing location, member and visit; only new ones are refused.

## SMS credits (M-3)
Orgs that send through the platform's messaging account (provider mode `platform`) prepay credit while billing is
on. Owners add 10, 25 or 50 USD on `/admin/billing` (Stripe Checkout; `checkout.session.completed` with
`metadata.purpose=sms_credit` credits the ledger once per session). Each sent message debits provider cost plus
`app.platform_flags.sms_margin_bps` (default 1000 = 10%); cost and margin are shown separately. At zero balance
sends are suppressed with `insufficient_credit`. A low-balance email goes out under `credit_low_micros` (default
5.00) once a day. There is no auto-refill. Add `checkout.session.completed` and
`checkout.session.async_payment_succeeded` to the Stripe webhook events.

## Monthly SMS bundle (B1)
A second recurring Price ($10/month, "about 500 texts") can share the location subscription. Set the Edge secret
`STRIPE_BUNDLE_PRICE_ID` to its Price id (and `STRIPE_LOCATION_PRICE_IDS`, above, before the first bundle exists) and
subscribe the webhook to `invoice.paid`. A paid, non-zero invoice that carries the bundle price calls
`api.apply_bundle_grant`, which adds `app.platform_flags.sms_bundle_grant_micros` (default 6000000 = $6.00, a
placeholder until the real Twilio rate is known; about 500 one-segment texts at 1.2 cents) to the same ledger as
top-ups, as an `addon_allowance` entry keyed by the invoice id, so a Stripe replay credits once.
- Credit rolls over and is never clawed back. A failed payment or cancellation simply produces no paid invoice, so
  grants stop; a paid invoice on a cancelled, unpaid or incomplete subscription is ignored.
- A bundle invoice for a subscription the database hasn't stored yet answers 500 so Stripe retries it.
- The bundle item is ignored when mapping subscription events to a plan and seat count, and seat sync never touches it.
- Plan changes take effect on Stripe's next cycle; nothing here prorates credit.
