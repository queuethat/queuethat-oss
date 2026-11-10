# Platform operator runbook

PLT15 (#421). This is how the maintainer, or a future operator, runs the platform console at `/platform`.
The console is for running the platform, not for doing a shop's work. Every action is
audited in `app.platform_audit`, and the actions that touch a tenant are also written to that
tenant's own `audit_log`, which the owner can read.

Two roles exist (`app.platform_roles`):

- **support** reads the directory, org detail, health and usage.
- **operator** can do everything support can, and also suspends, transfers, breaks glass, ends
  sessions, and writes entitlements and announcements.

Both need a two-step (aal2) session for every `api.platform_*` call.

## 1. Bootstrap an operator

There is no UI or RPC that grants a platform role. That is deliberate (technical-design.md 3.6).

1. The person signs up as a normal account and confirms their email.
2. Signed in, they open `/platform/mfa` and set up an authenticator app: they scan the QR code
   and enter a code. Any signed-in account can do this. Doing it before the role exists means
   nobody can claim a fresh operator account by enrolling first.
3. The maintainer runs, on his own machine:

   ```sh
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
     pnpm platform:grant <email> operator   # or support
   ```

   The script refuses an account that has no verified authenticator app. The grant is
   audited.
4. They sign out and in again, enter their code at `/platform/mfa`, and the console nav appears.

**Seeing who has access:** operators open **Team** (`/platform/team`): each person's role,
whether their authenticator app is set up, their last sign-in and who granted the role. The page
is read-only and only operators with a two-step session can open it. Anyone showing "Not set up"
cannot use the console yet, so check on them.

**Removing a role:** on your own machine, with the same connection settings as `platform:grant`:

```sh
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
  pnpm platform:revoke <email>
```

This removes the role (audited as `platform_role.revoke`) and deletes all of the person's
sessions, so a token they already hold stops working at its next refresh. Notes:

- Running it again is safe. With no role left it says so and only ends any sessions.
- An unknown email fails and changes nothing.
- It refuses to remove the **last operator**, so the platform is never left with nobody to run
  it. Grant another operator first, or add `--allow-last-operator` to remove yourself anyway
  (you can always grant a role again with `platform:grant`).
- Studio is no longer needed for this. The SQL delete that used to be here skipped the sessions.

**Lost phone (MFA recovery):** there are no recovery codes. Confirm who is asking through a
channel other than email. Then remove the role **first** (`pnpm platform:revoke <email>`) and the
factor second, using the SQL in [pilot-deploy.md](pilot-deploy.md) under "Authenticator-app MFA". The person sets up the app
again, and the maintainer runs `platform:grant` again. Removing the role first means that whoever has the
phone or password never gets a factor that comes with operator access.

**Five wrong codes** lock an account's codes for 15 minutes and sign it out. This is
`private.mfa_verification_attempt`. Wait it out; there is no override.

## 2. Answering a support request

**In-app requests (Contact support).** Signed-in owners, admins and staff can write to support from
the header of `/staff` and `/admin`. Each request arrives in two places:

- an email to the support inbox (`support@queuethat.com`, set by `app.platform_flags.support_inbox`
  for self-hosters) titled `[SR-000123] Business: subject`, with the message, the sender's address
  and role, the business and plan, the page path, app version, browser, window size, online state
  and the last error id, and a link to the tenant page;
- a row on the business's **Tenants** detail page under **Support requests**, open until you close it.

Triage: reply to the sender by email and quote the reference, open the tenant page for members,
screens and recent changes, then press **Close request** (**Reopen** undoes it; both are in the
platform audit). The sender also gets a confirmation email with the reference. A person can send
5 requests an hour; the same words twice within a minute count once. Suspended businesses can
still write. Requests never carry guest names, contact details, tokens or query strings: if a
sender pasted guest details into the message, say so in your reply and don't forward the email.
If the support email didn't arrive, check `app.notifications` for `template_key = 'support_request'`.

1. Find the business in **Tenants**: search by name, `/q/` slug or owner email. Its detail page
   shows the summary, members, locations and queues, screens with last seen, recent changes and
   any live support grant. That is usually enough to answer "is my queue open?" or "why is my
   display blank?".
2. If you need to see or change their data, ask the **owner** to grant access. In their app they
   open **Support access** from the admin dashboard, then choose **Read only** or **Read and
   change**, the hours (1 to 72) and a reason.
   - Every staff page shows a banner while access is open.
   - The owner can end it at any time.
   - Writes you make are recorded as `platform`, together with the grant id.
3. When you're done, tell the owner they can end access. It also ends by itself when the hours
   run out.

**Support grant or break-glass?**

|                | Support grant (owner gives)    | Break-glass (`api.platform_break_glass`)            |
| -------------- | ------------------------------ | --------------------------------------------------- |
| Use it for     | anything the owner asked for   | abuse, a legal request, an owner who can't be reached |
| Access         | read, or read and change       | read only                                           |
| How long       | 1–72 h                         | 1 h                                                 |
| Who is told    | the owner set it               | every owner is emailed, and the grant shows in their history |
| Who can end it | the owner                      | the owner; the operator can't end or hide it        |

A break-glass needs a written reason that holds up when the owner reads it. If you can ask the
owner, ask the owner instead.

## 3. Suspension and transfer

- **Suspend** (`api.platform_set_org_status`). Use it for
  non-payment, abuse or a compromised account. Its effects:
  - Guests can't join: the join page says the queue isn't taking guests right now.
  - Guests who are already waiting keep their status page, and can still leave.
  - Staff can still sign in and see their data, plus why it's unavailable. Every write (calling,
    config) fails with `org_suspended`.
  - Displays and kiosks stop.

  **Restore business** brings everything back, because nothing else is stored. The reason is
  shown to the business, so write it for them.
- **Transfer ownership** (`api.platform_transfer_ownership`). Use
  it when an owner leaves and the business asks, confirmed through a channel other than email.
  - The new owner must already be a member.
  - The previous owners become admins.
  - Both sides are emailed.

All of these are on the tenant's detail page in the console, under **Actions on this business**.
Each one asks for a reason and for you to type the business's join slug (`demo-barber` in
`/q/demo-barber`), says what it will do first, and shows the audit row it wrote when it's done.
Only operators see the buttons; a support role sees a note instead. Never use the Studio SQL
editor or the service role for these. There, `auth.uid()` is empty, so the platform check
refuses the call, and working around that would leave the action unattributed.

The reason isn't private. Suspend shows it to the business, and transfer and break-glass email it to
the owners, so write each one for them. Sign-out also ends sessions in a member's other businesses.

## 4. Incident: a compromised tenant

Do these in order. Each step is audited, and each one is safe to repeat.

1. **Suspend the org** (section 3). Member writes and guest joins stop at once.
2. **Sign everyone out** (`api.platform_sign_out_members`). This deletes their sessions and
   refresh tokens.
   - An access token they already hold stays valid until it expires (`jwt_expiry`, 5 minutes), and while
     suspended it can only read.
3. **Revoke all screens** (`api.platform_revoke_devices`). Devices are cut off on their next request. The shop pairs them again afterwards.
4. **Force password resets** for the members whose accounts may be compromised. In Supabase, go
   to Authentication → Users, open each user and choose **Send password recovery**.
   - There is no RPC for this on purpose: it needs the service role.
   - Tell the owner by phone first, so the reset email isn't mistaken for phishing.
5. Find out what happened from the org's recent changes on its detail page and from
   `platform_audit`. Then **unsuspend** when the owner confirms they're back in control.

## 5. Announcements

Use **Announcements** in the console for planned maintenance or a platform incident. Every
signed-in staff member sees them as a banner; guests never do.

- **Info** can be dismissed. **Warning** and **Maintenance** can't, so nobody misses downtime.
- An end time is required, so a forgotten announcement can't stay up forever.
- You can schedule an announcement ahead. It's listed as "Scheduled" until it starts.
- **End now** takes it down, or cancels it if it's still scheduled.
- Keep messages short and say when things will be back, for example "Texts may be late until
  14:00 UTC. Calling and the display still work."

## 6. Reading `/platform/health`

It refreshes every 30 seconds. Counts only, no tenant data.

| Tile or row                     | Healthy           | When it warns, check                                                                  |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| Notifications waiting to send   | small and falling | the dispatcher: `kick-dispatcher` cron row, Edge Function logs                        |
| Oldest waiting                  | under 5 minutes   | as above; over 5 minutes means guests are getting "you're up" texts late              |
| Dead notifications              | 0                 | gave up after retries: provider outage, bad number or a provider credential. Read `app.notifications.error_code` for those rows |
| Businesses with a join today    | —                 | a sudden 0 on a weekday means joins are broken; open a join page yourself             |
| Scheduled jobs                  | Succeeded, on     | a **Failed** or **Turned off** row: read `cron.job_run_details` for that job. `check-dispatcher` **Failed** means the dispatcher answered with a non-2xx (the message names it, e.g. 401 after a changed `dispatcher_key`); it clears once a later kick succeeds or 10 minutes pass without one; `kick-dispatcher` itself stays green because it only queues the request |

**Usage** (`/platform/stats`) shows the last 30 UTC days, filled in at 00:15 UTC each night.
Today stays empty until tomorrow.

Error reports open from **Open error reports** when `VITE_SENTRY_ISSUES_URL` is set, and
uptime and job heartbeats alert by phone ([observability.md](observability.md)).

## 7. Reading `/platform/funnel` (activation)

Use this during the soft launch to see which tenants signed up and stopped, and where. Support
and operators both see it. It reads counts and times only, never guest data.

**Stages**, all derived from existing tables (there is no event table), in order:

| Stage                      | Reached when                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| Signed up                  | The founding member's account exists (or the business, if that is earlier)   |
| Business created           | The business row exists                                                      |
| Location added             | It has a location                                                            |
| Queue created              | It has a queue                                                               |
| Line live                  | A queue that is not archived is open now                                     |
| First guest joined         | Any visit exists                                                             |
| First guest served         | Any visit was served                                                         |
| Staff invite accepted      | An invitation was accepted (side milestone, not part of the path)            |
| Card on file               | A Stripe subscription got past `incomplete` (side milestone)                 |

A later stage implies the earlier ones, so a business that served a guest counts as having gone
live even if its queue is closed or archived today. "Line live" has no history of its own, so its
date is the queue's creation date or the first visit, whichever is earlier.

**Stuck** means an active business that has sat at one stage for **3 days or more** without
reaching first served. The clock starts when it reached its current stage. Suspended and
pending-deletion businesses are counted in the stages but are never listed as stuck. The threshold
is `private.activation_stuck_days()`.

- The date range filters on when the business was **created**, as UTC days, both ends included.
  The default is the last 30 days. The first row also counts accounts that signed up in the range
  and never created a business; they cannot be listed because they have no tenant to open.
- Each conversion compares a stage with the one before it. The two side milestones compare with
  signups, because they do not depend on the path.
- The stuck table is ordered longest stuck first. Filter by "Stopped at", then open the business
  to see every stage with its date. The same block is on each tenant's page, and the directory
  shows a badge (Live, Setting up, Stuck, Suspended).
- Before emailing a stuck owner, check the tenant page: a business stopped at "Line live" with a
  closed queue may simply be closed for the season.

## 8. Never do this

- **Don't read or change tenant data with the service-role key in Supabase Studio** (the
  table editor or SQL as `postgres`). It bypasses RLS, support grants and the audit trail, and
  the owner can't see it happened. Use a support grant, or break-glass for abuse and legal
  requests.
- Don't put the service-role key anywhere but the maintainer's machine and the Edge Function secrets.
- Don't grant a platform role to an account without a verified authenticator app. The script
  refuses, so don't work around it in SQL.
- Don't suspend to "test" on a real tenant. Use your own test business.
- Don't hard-delete visits or edit `visit_events` (I-1). Fix data forward through the `api.*`
  functions under a support grant.
