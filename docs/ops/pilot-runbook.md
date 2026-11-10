# Pilot runbook

How to put a shop on the system, run its day, and recover when something breaks. The deploy
settings are in [pilot-deploy.md](pilot-deploy.md); do those first.

Parts of this depend on tickets that are still open. Each one is marked **Not built yet** with
its ticket, so nobody relies on a safety net that doesn't exist.

## 1. Before the first day

**Accounts**

- [ ] The owner signs up at `/auth/sign-up` and finishes onboarding: business, location, time
      zone and the first queue.
- [ ] Under **Admin → Location**, check the time zone and "new day starts at". The service day,
      ticket numbers and rollover all follow them.
- [ ] Leave **Show customers' names** off unless the owner asks for it. With it on, the TV
      shows first names to everyone in the room.
- [ ] Each staff member gets their own account and membership. Never share the owner's login.

**Queues and services**

- [ ] Under **Admin → Queue setup**: a short ticket prefix per queue, a "servers on duty" count that
      matches the chairs actually staffed, and "show wait time" on.
- [ ] Under **Admin → Queue setup**, open each queue and set its services' expected minutes realistically. The wait estimate is built from
      these numbers and the queue length, so a 20-minute cut entered as 10 halves every quote.
- [ ] Under **Admin → Counters**: one counter per chair or desk, with the label the TV shows
      ("Chair 2").

**Devices**

- [ ] **TV:** open `/display` in the TV's browser, then under **Admin → Screens** create a
      display pairing code and type it on the TV. Codes work once and expire after 10 minutes.
      Then turn off the TV's own sleep timer. The board asks the browser to stay awake, but
      not every TV browser supports that.
- [ ] **Staff tablet:** sign in at `/staff` and add it to the home screen.
      The console asks the browser to keep the screen on while it is open; leave it open on the counter.
- [ ] **Never sign a paired TV into a staff account.** The TV's session is the device's own, and
      revoking it under **Admin → Screens** sends that screen back to pairing.

**Posters**

- [ ] Print the join QR code for `/q/<location slug>` and put it at the door and the counter.
      `/q`, `/v`, `/display` and `/kiosk` URLs never change (I-10), so a printed poster stays
      valid.

**Rehearsal**

- [ ] Run a busy day locally (`pnpm simulate:day`, see section 5). Its services are fixed in
      the script (`SERVICES`); set them to the shop's real ones first.

## 2. Morning checklist (each day)

- [ ] The TV shows **Now serving** with no "Reconnecting" banner.
- [ ] Staff are signed in on the tablet, and the queue shows **Open**.
- [ ] Join from your own phone through the poster. The ticket appears on the tablet and under
      "Next up" on the TV. Leave again from the status page.
- [ ] Yesterday's leftovers are gone. Rollover expires waiting and called visits and closes
      serving ones within 5 minutes of the location's new day (`rollover-tick`, every 5 minutes).

## 3. When something fails

The rule for every incident: guests keep their place. Visits are never deleted (I-1), every
change is logged in `visit_events`. The console can call next or a specific guest, recall,
start, finish, send back to line, mark a no-show, remove and reinstate, open, pause and close
the queue, and add a walk-in. Every console action offers **Undo** for 10 seconds; after that,
fix a mis-tap with the opposite action (Back to line, Reinstate).

### Realtime is down or slow

- **What you see:** the TV and tablet show "Reconnecting", within about 15 seconds of the
  socket going quiet. Updates arrive late, but they still arrive.
- **Why it's survivable:** realtime only says "something changed". Every screen also polls
  every 30 seconds and refetches when it comes back to the foreground or the network returns.
  A dead socket makes updates slower, never wrong.
- **What to do:**
  1. Check the Supabase status page and the project's Realtime logs.
  2. Count open sockets. The Free plan, and the local CLI, cap Realtime at **200 concurrent
     connections**. The 201st client is refused and falls back to polling
     ([realtime-spike.md](realtime-spike.md)). If a busy day hits the cap, that's a plan
     upgrade, not a bug.
  3. Self-hosted: Kong's default of 512 worker connections also starves REST at about 250
     sockets. See the K1 notes.
- **Tell staff:** "the board is a little slow, call by name as usual". Nothing else changes.

### Push alerts aren't arriving

- **Expected limits:** push needs the guest to opt in on the status page. iPhones only receive
  push from a site added to the home screen. A guest who never opted in gets nothing.
- **What to check:**
  1. The dispatcher runs: `pg_cron` job `kick-dispatcher` every 15 s, and the
     `dispatch-notifications` function logs.
  2. The VAPID secrets are set on the function (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
     `VAPID_SUBJECT`). Without them, push rows are dead-lettered as `no_channel`.
  3. Rows in `app.notifications` for the visit: `queued`, `claimed`, `sent`, `failed`, `dead`
     or `suppressed`. Six failed attempts mark a row `dead`.
  4. A push service answering "gone" deletes the subscription. That is normal when a guest
     clears their browser.
- **Meanwhile:** staff call guests by ticket number and the TV shows the call. Push is a
  convenience, never the only signal.

### Email isn't arriving

- **Guest email** is sent by `dispatch-notifications` through the provider the org configured
  under **Admin → Integrations** (Resend, with the org's own key and sender; see
  [email-providers.md](email-providers.md)). With `LOCAL_PROVIDERS_ONLY` left at its default
  (`true`) only the local mail catcher is registered, so on a hosted deployment set it to `false`
  or guest email goes nowhere: rows are dead-lettered as `no_channel`. An org that never set up
  email sends none, and an address typed at the join form is emailed only after it is verified.
- **Staff sign-in email** goes through Supabase Auth, not the outbox. If magic links or codes
  don't arrive, check Auth's SMTP settings (Resend, `smtp.resend.com`; steps in
  [pilot-deploy.md](pilot-deploy.md)) and the Auth rate limits.
- **When a provider is set up, check:** suppressions (bounces and complaints suppress an address in
  every org), the per-address daily cap (20 guest messages per address per day across the
  platform), and the unsubscribe secrets ([unsubscribe-secrets.md](unsubscribe-secrets.md)).

### Texts aren't arriving, or a business's texts stopped

- Hosted texts go out from one shared QueueThat number ([platform-twilio.md](platform-twilio.md)).
  They work only on paid plans, and only after the platform sender is switched on.
- **A business stopped sending with no change on its side:** it may have been auto-paused. Every
  5 minutes the platform scores each business's last 24 hours and pauses it when STOP replies,
  carrier-filtered or undelivered texts pass the thresholds. Look for `sms.auto_pause` in the
  platform audit log (nobody is notified), and lift the pause from **/platform → business page →
  Platform text messages** (a reason is required and recorded).
- **A guest says STOP:** that guest is suppressed for every business on the shared number until
  they text START. Texts to a number a guest only typed are sent after it is verified.

### A flood of joins

- Joins are capped per phone, per network (60 per IP per queue in 10 minutes), per queue per
  minute, and per queue per hour (the queue's online-join limit). When a cap is hit, the join
  page sends guests to the counter. Staff adds are never capped.
- If a real crowd hits the hourly cap, raise the queue's online-join limit under
  **Admin → Queue setup** (1 to 1000).
- If it's abuse, pause the queue and add walk-ins at the desk (console: **Pause**, **Add walk-in**).
- **Not built yet:** the edge rate-limit rule on `join_queue` (#76).

### The TV is frozen, blank or shows the pairing screen

1. Reload the page. It keeps its device session across reloads.
2. Still on the pairing screen: the device was revoked or its session expired. Create a new
   code under **Admin → Screens** and pair again.
3. The screen updates itself to a new deploy when it has been idle for 5 minutes, at most once
   per cooldown. A TV stuck on an old version just needs a reload.

### The database or API is down

1. Pause handing out tickets: put a sign on the poster ("ask at the counter").
2. Staff keep a paper list in arrival order.
3. When it's back, add the paper guests as walk-ins, in their original order.
4. Check the Supabase status page and the UptimeRobot alert. The `health` function names what
   failed (`database`, `rollover`, `dispatcher`, `outbox`); see
   [observability.md](observability.md).

## 4. Backups, rollback and data

- **Backups:** nightly, encrypted, kept 14 days in R2, and restored every Monday by the drill.
  Setup, what the drill checks and how to restore for real: [backups.md](backups.md). If the
  `qm-backup` or `qm-restore-drill` Healthchecks alert, treat it as urgent: until the next good
  run, a lost project loses data.
- **Rolling back the web app:** redeploy the previous build. On Vercel, open the project's
  Deployments, find the last good production deployment, and choose **Promote to Production**
  (or **Instant Rollback**). Migrations are
  expand/contract (I-12), so the previous app still works against the newer schema.
- **Rolling back the database:** there are no down migrations. Fix forward with a new
  migration. Never edit or revert a merged migration.
- **Errors:** Sentry (or GlitchTip) receives redacted error reports from the web app and the
  Edge Functions once `VITE_SENTRY_DSN` is set; setup in [observability.md](observability.md).
  Without it, read the Supabase logs.
- **Personal data:** dumps and logs contain guest names, phones and emails. Never copy them
  anywhere unencrypted.

## 5. Rehearse with the simulator

`pnpm simulate:day` drives a 10-hour day through the real RPCs against **local** Supabase:

- 150 guests arrive with lunch and after-work peaks. 75% join by phone and 25% are added at
  the desk. 5% leave while waiting and 6% never show when called.
- Four staff call, start and complete guests at their own counters.

It fails unless every visit ends in a terminal state with an unbroken event chain. It then
reports how often the actual wait fell inside the quoted range, and how fast the staff `loc:`
signal and the guest `qpulse:` pulse arrived after each call (and how many never did).

Options: `--visits`, `--servers`, `--no-shows`, `--leaves`, `--seed` (the same arrivals and
choices; outcomes still vary a little with timing), `--speed` (default 60, so a day takes
about 11 minutes) and `--min-within <percent>` (fail when fewer waits than that land inside the
quote, artifact removed). It is local only. It raises the per-network join cap for the run and
puts it back, pauses the `refresh-duration-stats` job (learned service times would be 60 times
too short at speed and wreck every later quote), and it leaves a "Sim" queue and counters until
`pnpm db:reset`.

**Read the ETA numbers with this in mind.** The estimate counts guests already being served as
holding a chair for "expected minutes minus time spent so far", measured by the database's real
clock, which runs 60 times slower than the simulated day. The report prints the quotes as
given and again with that artifact removed; only the second describes the formula. Since #548
the formula allows for guests taking the first chair that frees.

## 5b. Rehearse the day on the live pilot (#80)

`pnpm test:e2e:pilot` plays the day-in-the-shop journey (`tests/e2e/day-in-the-shop.spec.ts`)
against the deployed app on a desktop and an iPhone browser: guests join from the poster page
and the desk, two tablets call next together, a guest is served, a mistaken no-show is undone,
a guest leaves, the queue is closed under an open join page, and the TV follows every step.
Run it after each deploy, before opening the doors.

It uses only public values and two test accounts, never the service-role key or the database:

```sh
export PUBLIC_URL=https://queue.example.com          # the web app
export E2E_SUPABASE_URL=https://<ref>.supabase.co    # the project URL
export E2E_SUPABASE_ANON_KEY=<anon key>
export PILOT_LOCATION_SLUG=<shop slug>               # the poster page is /q/<slug>
export PILOT_OWNER_EMAIL=... PILOT_OWNER_PASSWORD=...  # an owner of that shop
export PILOT_STAFF_EMAIL=... PILOT_STAFF_PASSWORD=...  # a staff account of that shop
pnpm test:e2e:pilot
```

The shop needs at least two counters. The run creates one queue and one TV pairing, and
removes both at the end (the queue is archived, the TV device revoked). The guests it adds
are real visits in that queue, so run it when the shop is closed.

What differs from the local run:

- **Join protection.** If the join page is protected by a real Turnstile key, a headless
  browser cannot pass it, and the run stops with that message. Rehearse on a staging copy, or
  with Turnstile's always-pass test key (`docs/ops/turnstile.md`).
- **Day rollover.** The local run time-travels the database. The pilot run cannot, so staff
  remove the leftover guests, and it checks `GET /functions/v1/health` is 200 (the rollover
  heartbeat is part of that check). The rollover itself is checked by the health call and
  the pgTAP rollover tests, not replayed.
- **Not covered:** that a push or an email actually arrives. Check those by hand
  (section 3, "Push alerts" and "Email").

## 6. Contacting the maintainer

Use this for an outage, data loss, or anything that stops a shop taking guests: **(fill in
before the pilot: phone or messaging handle, and hours)**. Include the shop, the time, what
the screens showed, and anything already tried.

## Opening a paid channel (compliance gate)

`api.set_channel_enabled` refuses to switch SMS, email, WhatsApp or payments on until the deployment says
the compliance gate suite passed for this build. Nothing in the app sets that flag. After the gate suite
(3-CG14) is green for the build you are deploying, run once as the database owner:

```sql
update app.platform_flags set compliance_gate_passed_at = now();
-- hosted deployments that offer a platform messaging account (PLATFORM_MESSAGING_ENABLED), after the legal review:
update app.platform_flags set hosted_legal_reviewed_at = now();
```

An owner then enables a channel from Admin > Integrations once their own prerequisites hold: verified provider
settings (a signed test event received), for SMS a daily cap above zero and a country allowlist, and for US
numbers the 10DLC campaign reference. A refused attempt lists what is missing (`channel_prerequisite_missing`,
DETAIL). To close the gate again, set `compliance_gate_passed_at = null`: the dispatcher stops resolving every paid
channel at once, because `api.get_channel_config` re-checks the prerequisites on every read.
