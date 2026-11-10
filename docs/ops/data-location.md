# Data location

C1 (#1268). What QueueThat Cloud can truthfully say about where data lives. The public version is
queuethat.com/subprocessors; keep the two in step. Never claim "all data stays in Canada".

## Where data lives

| Item                         | Location                              | Status                                                                                   |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Production database (Supabase) | Canada | Confirmed by the maintainer, 2026-11-09. Dashboard > Settings > General > Region shows it. |
| Dev database | Not recorded                | Unverified. It holds demo and test data only; never put real guest data in it.            |
| Nightly encrypted backups (Cloudflare R2) | Not recorded | Unverified. No jurisdiction or location hint is set in the repo or workflows (`AWS_DEFAULT_REGION=auto`). Check the bucket in Cloudflare > R2 > Settings. |
| Web app and logs (Vercel)    | United States and other edge regions  | Not controllable on the current plan.                                                    |

## What leaves Canada

Everything below processes data outside the production database and may do so in the United States
or elsewhere:

- **Resend**: email address and message content (sign-in codes, receipts, guest notices).
- **Twilio**: phone number and message content for opted-in text alerts.
- **Browser push services** (Google, Apple, Mozilla): the push endpoint and message, only for
  devices that opted in. Payloads carry no contact details.
- **Stripe**: billing identity and payment data.
- **Vercel**: request logs (IP address, browser type) and the delivered app.
- **Cloudflare Turnstile**: bot-check tokens and IP address on sign-up and join forms.
- **Cloudflare R2**: age-encrypted backups; Cloudflare holds no key. Location unverified, see above.

## Wording rules

- Say "our production database is hosted in Canada", not "your data stays in Canada".
- Retention: tenant-configurable, maximum 365 days (C3 enforces the cap), backups 14 days.
  Until C3 merges the database still accepts up to 3650 days (`20261030065000_retention.sql`).
- Update this file and the site page in the same change whenever a provider is added or removed.

## To close the open items

1. Check the R2 bucket location in Cloudflare. R2 offers location hints and the EU and FedRAMP
   jurisdictions, but no Canada option, so the backups cannot be promised to be in Canada. Keep
   the site page's "not yet confirmed" wording until the location is known.
2. Confirm the dev project region and note it above.

## Self-hosting

An operator chooses the server and region. No QueueThat-run provider is involved unless the
operator configures Resend, Twilio, push or Stripe themselves.
