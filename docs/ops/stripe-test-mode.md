# Stripe test mode (V-4)

`StripePaymentProvider` (`packages/providers/src/payments/stripe.ts`) talks to the Stripe REST API
with `fetch`. Only test mode is supported until phase 3: constructing it with an `sk_live_` key
throws unless `PAYMENTS_LIVE=true`. CI never touches the network; it runs the same contract suite
against `FakePaymentProvider` and against Stripe-shaped HTTP fixtures.

## Local setup
1. Create a free Stripe account and copy the **test** secret key (`sk_test_...`).
2. Forward webhooks to the local `payment-webhook` function (2B-V2):
   `stripe listen --forward-to http://127.0.0.1:55321/functions/v1/payment-webhook`
   It prints a signing secret (`whsec_...`).
3. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Edge Function secrets. Never put them in `apps/web`.
4. Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 9995` declines (`insufficient_funds`).

## Behaviour
- `createHold` makes a PaymentIntent with `capture_method=manual`, `createDeposit` one with automatic
  capture, `saveCard` a Customer plus SetupIntent (`usage=off_session`), `chargeSavedCard` an
  off-session confirmed PaymentIntent, and `refund` a Refund. All carry an `Idempotency-Key`; the
  client confirms with `clientSecret` through Stripe's Payment Element (card data never reaches us).
- Failures are `PaymentError`: `retryable` is true for network errors, 5xx, 429 and 409, false
  for everything else (declined card, capture above the authorised amount), so jobs dead-letter at once.
- `parseWebhook` checks `Stripe-Signature` (v1 HMAC-SHA256 over `t.body`, constant-time compare,
  5-minute tolerance) and throws on a bad or stale signature. Unhandled event types return `[]`.

## Guest payments (3-PAY3)
- `payment-intent` (public, per-token rate limit) turns a visit or appointment token into a Payment Element client secret; the amount always comes from the service's payment policy. Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `PUBLIC_URL` (or `PAYMENT_PROVIDER=fake` locally).
- `payment-jobs` runs queued captures, releases, refunds and no-show charges. It is kicked after commit by pg_net when the Vault secret `payment_jobs_url` is set (like `webhook_sender_url`) and every minute by pg_cron; it needs `DISPATCH_SECRET`. Each job calls the provider with the job id as idempotency key and goes dead after 6 retryable failures.

## Booking waits for the card (3-PAY8)
- A guest booking of a service with a payment policy starts `pending_payment`: it holds the slot but is not `booked` (no reminders, no expected visit) until the hold is placed, the deposit paid or the card saved. The provider webhook confirms it; `ops.expire_unpaid_appointments` (pg_cron, every minute) cancels it with reason `payment_expired` and frees the slot when `payment_policies.pay_within_minutes` (default 15) passes first.
- This is enforced by a trigger on `app.appointments`, so skipping the card step in the browser (or never calling `payment-intent`) cannot keep the booking. Staff bookings and event seats are exempt. A waitlist claim of a paid service is pending too.
- A card that succeeds after its booking was cancelled or expired is released (hold) or refunded (deposit) automatically.
- With `PAYMENT_PROVIDER=fake` no card can be collected, so a booking under a policy expires after the window. Locally, deliver a fake `authorized` event to `payment-webhook` to confirm one, or set the policy to `none`.

## Payment at the counter (4-PAY1)
- Staff (any role at the location) call `api.staff_request_payment(visit, amount, currency, key)` for a called, serving or served visit. It creates a `pos` payment (`pending` provider) that charges at once; the amount comes only from staff, never from the guest. Asking again replaces the amount until the guest's page has opened the request (that is when the Stripe intent is created); after that fix a wrong amount with a refund.
- The guest's status page asks `payment-intent` with `{ token, pos: true }`; it answers 409 `payment_not_required` while nothing is requested. The same webhook marks the payment `succeeded`.
- The receipt email (`receipt` template, transactional) is queued when the payment succeeds, only for a verified email contact. An email typed into the join form never gets one: anyone could aim it at someone else.

## Pay code on the staff tablet (4-PAY2)
- The guest link token is stored only as a hash, so the tablet cannot encode `/v/<token>`. **Show pay QR** on an unpaid counter payment calls `api.staff_create_pay_code(visit)`, which returns an 8-character code (alphabet without look-alikes, shown `ABCD-2345`) valid for 10 minutes. The QR encodes `/pay/<code>`.
- Only a sha256 of the code is stored (`app.pay_codes`). Asking again replaces the earlier code. The code opens the card form for that one payment: it is not a link token and shows no status page or contact data. It stops working when the payment is paid or refunded, or after 10 minutes. This is "single use" per payment, not per scan: the page must survive a reload and a 3-D Secure redirect.
- `/pay/<code>` calls `payment-intent` with `{ code }`. Unknown, expired, replaced and already-paid codes all get the same 404 and one message on the page. Limits: 30 tries a minute per code (spellings share one), 20 per caller IP where the platform reports one, 300 overall.
