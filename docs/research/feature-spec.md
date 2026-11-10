# Queue management: complete feature list

The feature ids used in code comments, tests and pull request titles (`J-1`, `S-11`, ...) are defined here. This is a backlog, not a build plan. Building every row is several person-years of work; the priority column is the build plan.

**Priority**
- **P0** MVP. Without it the product doesn't work for one shop with one queue.
- **P1** Needed before a second real business would use it.
- **P2** Competitive parity with Waitwhile Starter/Business.
- **P3** Enterprise or nice-to-have. Build only on demand.

**Build** (local-first: finish local development, then switch on paid integrations)
- **Local**: builds and runs fully in the local Docker/Supabase stack. No external service.
- **Effort**: local too, but notably complex or slow to get right.
- **Paid**: needs a paid service in production (SMS, WhatsApp, payments, email delivery, domains). Build the feature now behind a provider interface with a local stub (see module 17), then switch on the real provider in the integrations phase.

**★** marks a differentiator drawn from competitor complaints.

## Build phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 1. Local core | All P0 rows, plus the provider interfaces in module 17 | One real shop could run a day on it via a tunnel |
| 2. Local completeness | P1 and P2 rows marked Local or Effort | Feature parity with Waitwhile Starter/Business, minus paid channels |
| 3. Paid integrations | Every row marked Paid, swapping stubs for real providers | SMS, WhatsApp, email, payments live; per-message cost tracked |
| 4. Enterprise / on demand | P3 rows | Built only when a specific customer asks |

---

## 1. Organization, locations, and access

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| ORG-1 | Sign up / sign in (email + password, magic link) | P0 | Local | Supabase Auth |
| ORG-2 | Organization (tenant) with name, logo, timezone, locale | P0 | Local | Every table keyed by org_id; Postgres RLS from day one |
| ORG-3 | Locations under an org: address, timezone, contact info | P0 | Local | Single location in MVP UI, multi in schema |
| ORG-4 | Multi-location switcher and cross-location dashboard | P2 | Local | |
| ORG-5 | Business hours per location, weekly editor | P0 | Local | ★ Visual editor; Waitwhile reviewers say hours are hard to change |
| ORG-6 | Holiday and one-off exceptions (closed, special hours) | P1 | Local | |
| ORG-7 | Staff invites by email | P1 | Local | |
| ORG-8 | Roles: owner, admin, manager, staff, display/kiosk device | P1 | Local | Device role = scoped long-lived token, no human login |
| ORG-9 | Custom roles with granular permissions | P3 | Effort | Waitwhile gates this to Business |
| ORG-10 | Per-location staff assignment | P2 | Local | |
| ORG-11 | Audit log of admin and staff actions | P1 | Local | Also used to debug "lost" entries |
| ORG-12 | SSO (SAML / OIDC) | P3 | Effort | |
| ORG-13 | Two-factor auth for staff | P2 | Local | Supabase TOTP |
| ORG-14 | Industry templates at setup (barber, clinic, restaurant, DMV-style counter, retail repair, events) | P1 | Local | ★ Under-5-minute setup vs. months for Qmatic/Wavetec |
| ORG-15 | Every setting editable from any device (web, tablet, phone) | P1 | Local | ★ NextMe: some settings only in the app, others only on the web |
| ORG-16 | Staff shift scheduling (who works when, across midnight) | P2 | Local | WaitWell sells this vs. Waitwhile; Wavetec lacks cross-day hours |

## 2. Queues, services, and resources

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| Q-1 | Multiple queues per location | P0 | Local | |
| Q-2 | Services (name, description, expected duration, color) | P0 | Local | Drives ETA |
| Q-3 | Resources: staff members, counters/desks, rooms, tables, chairs | P1 | Local | |
| Q-4 | Service ↔ resource mapping (who can serve what) | P1 | Local | |
| Q-5 | Queue open/close/pause manually and on schedule | P0 | Local | Pause = no new joins, existing guests kept |
| Q-6 | Capacity limit per queue; auto-close when full or when ETA exceeds closing time | P1 | Local | Prevents promising service you can't deliver |
| Q-7 | Party size, min/max | P1 | Local | Restaurants, families |
| Q-8 | Custom intake fields per queue (text, select, checkbox, phone, number, date, file) | P1 | Local | Required/optional, visible to staff only or guest |
| Q-9 | Ticket numbering formats (A001, per-service prefixes, daily reset) | P0 | Local | |
| Q-10 | Priority classes (VIP, accessibility, elderly, appointment holder) with rules | P2 | Local | |
| Q-11 | Routing rules: send to queue by service/answers; round-robin or least-busy counter | P2 | Effort | |
| Q-12 | Multi-step journeys (registration → triage → doctor) with transfer between queues | P2 | Effort | Common in clinics and government offices |
| Q-13 | Late-arrival / grace-period policy and auto no-show after N minutes | P1 | Local | |
| Q-14 | Join restrictions: only when on-site (geofence) or from a location QR code | P2 | Local | Browser geolocation is free; anti-abuse |
| Q-15 | Per-queue message templates and branding overrides | P2 | Local | |
| Q-16 | Hide or show the quoted wait time per queue | P1 | Local | ★ Waitwhile and NextMe users turned off inaccurate estimates entirely |
| Q-17 | Closing a queue closes every entry point (page, widget, kiosk, SMS) | P0 | Local | ★ Waitwhile: embedded form still accepted joins after the list was switched off |
| Q-18 | Assign a waiting guest to a specific staff member or counter | P1 | Local | ★ Top Qminder G2 complaint; WaitWell cites the same gap in Waitwhile |

## 3. Ways for guests to join

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| J-1 | Public join page by link | P0 | Local | No app, no account |
| J-2 | Printable QR code poster per location/queue | P0 | Local | ★ Stable URLs guaranteed across versions |
| J-3 | Staff adds guest manually (name, phone/email optional) | P0 | Local | Many guests won't scan anything |
| J-4 | Kiosk mode on a tablet (self check-in, large touch UI, idle reset) | P1 | Local | PWA in full-screen; device role token |
| J-5 | Embeddable widget / button for the business website | P2 | Local | |
| J-6 | Join with an existing appointment (check-in) | P1 | Local | |
| J-7 | Google Business Profile booking link | P2 | Local | The Google Maps join integration Waitwhile has needs partner approval; not feasible |
| J-8 | Join by SMS keyword | P2 | Paid | Needs inbound number + 10DLC registration |
| J-9 | Join by WhatsApp / Telegram bot | P3 | Paid | |
| J-10 | Join by phone call (IVR) | P3 | Paid | |
| J-11 | CAPTCHA / rate limit on public join | P1 | Local | Cloudflare Turnstile is free; protects against fake joins |
| J-12 | Duplicate detection (same phone/device already in queue) | P1 | Local | Idempotency key per device |
| J-13 | Join for later ("arrive at 3pm") without a formal appointment | P2 | Local | |
| J-14 | Group join / add companions to one party | P2 | Local | |
| J-15 | Several parties or people under one phone number | P1 | Local | ★ Waitwhile clinic: couldn't book two patients with the same number |
| J-16 | Block joining several queues at once across locations (configurable) | P2 | Local | ★ Waitwhile reviewer complaint |
| J-17 | Phone input with country code, format-as-you-type, no aggressive autocomplete, edit one digit without retyping | P0 | Local | ★ Waitwhile: wrong numbers from autocomplete; had to erase the whole entry |
| J-18 | No guest account or sign-in required | P0 | Local | ★ Qminder G2: customers object to mandatory sign-ins |
| J-19 | Analytics/marketing pixels on join page (GA4, Meta) with consent | P3 | Local | Waitwhile reviewer asked for this |

## 4. Guest experience (status page)

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| G-1 | Live status page: position, people ahead, ETA, status | P0 | Local | Supabase Realtime |
| G-2 | ETA shown as a labelled range ("about 10–20 min left") | P0 | Local | ★ Fixes the "time waited vs time remaining" confusion |
| G-3 | Leave queue button | P0 | Local | ★ QLess users couldn't cancel |
| G-4 | "I'm on my way" / "Need 5 more minutes" (snooze/push back) | P1 | Local | |
| G-5 | On-page alert when called: sound, vibration, full-screen color change | P0 | Local | Baseline for iPhones without push |
| G-6 | Business contact info and directions on the page | P1 | Local | |
| G-7 | Ticket QR code on the page for counter scanning | P1 | Local | ★ G2 complaint: no QR/barcode scanning |
| G-8 | Add appointment to calendar (.ics) | P1 | Local | |
| G-9 | Multi-language guest UI with auto-detect | P1 | Local | |
| G-10 | Accessibility: WCAG 2.1 AA, screen reader, large text, high contrast | P1 | Local | |
| G-11 | Post-visit feedback (rating + comment) | P2 | Local | |
| G-12 | Rejoin / "join again" from history | P3 | Local | |
| G-13 | Offline-tolerant status page (shows last known state, reconnects) | P1 | Local | |
| G-14 | Public "current wait" view for a location before joining | P1 | Local | |
| G-15 | Guest-to-staff chat on the status page (no SMS) | P2 | Local | Two-way chat without SMS cost |

## 5. Notifications

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| N-1 | Web push (VAPID) | P0 | Local | iPhone needs home-screen install (iOS 16.4+); Android works directly |
| N-2 | Email (confirmation, called, reminders) | P1 | Paid | Locally: Mailpit catches all mail. Prod: SES/Postmark/Resend (free tiers exist). Too slow for "you're next" |
| N-3 | Telegram bot notifications | P2 | Local | |
| N-4 | WhatsApp click-to-chat link (`wa.me`) for staff to message guests manually | P2 | Local | No API costs |
| N-5 | SMS (Twilio / Vonage / Plivo / Telnyx) behind a provider interface; platform account or per-business keys | P2 | Paid | ★ Transparent per-message cost vs. Waitwhile's auto-refill credits. Locally: console/log provider |
| N-6 | WhatsApp Business API (join, updates, two-way) | P2 | Paid | Wavetec sells WhatsApp queuing; big in non-US markets |
| N-7 | Two-way SMS with inbound replies ("C" to confirm, "L" to leave) | P2 | Paid | |
| N-8 | Notification triggers: joined, position changed, almost up (N ahead / X min), called, no-show warning, removed, served | P0 | Local | |
| N-9 | Re-notify on reorder or ETA change beyond a threshold | P1 | Local | ★ Waitwhile texts didn't update after reorder |
| N-10 | Editable templates with variables and live preview; segment counter for SMS | P1 | Local | ★ Shows SMS segment cost instead of a hard char limit |
| N-11 | Channel fallback chain (push → SMS → email) | P2 | Local | |
| N-12 | Delivery status tracking per message | P2 | Local | |
| N-13 | Quiet hours and opt-out/consent handling (STOP keywords for SMS) | P2 | Local | Legal requirement once SMS is used |
| N-14 | Staff alerts with audible sound, volume test, "sound is on" indicator | P0 | Local | ★ G2 complaint: notifications silent |
| N-15 | Bulk message to everyone in a queue ("running 20 min late") | P1 | Local | Qmatic added bulk SMS in 2025 |
| N-16 | No cap on automated messages per visit | P1 | Local | ★ Waitwhile reviewer: only 2 automated messages, rest manual |
| N-17 | Guests get only the alerts they opted into | P1 | Local | ★ Qminder: alerts from departments the user didn't pick |

## 6. Staff console

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| S-1 | Live queue list across devices, realtime sync | P0 | Local | |
| S-2 | Call next / call specific guest | P0 | Local | |
| S-3 | Statuses: waiting, called, serving, served, no-show, cancelled, transferred | P0 | Local | State machine enforced in DB |
| S-4 | Drag to reorder | P1 | Local | |
| S-5 | Transfer to another queue/service/staff | P1 | Local | |
| S-6 | Recall (call again) and undo last action | P0 | Local | ★ Prevents "lost" guests |
| S-7 | Counter / desk selection per staff session | P1 | Local | Feeds the display "A012 → Counter 3" |
| S-8 | Notes and tags on a visit | P1 | Local | |
| S-9 | Search and filter (name, phone, ticket, service) | P1 | Local | |
| S-10 | Keyboard shortcuts for desktop | P2 | Local | |
| S-11 | Tablet-first layout, large hit targets, works on old devices | P0 | Local | ★ Clunky-on-old-tablets complaint |
| S-12 | Offline queue of staff actions with reconciliation | P2 | Effort | |
| S-13 | Scan guest QR to check in / call | P1 | Local | Camera via browser |
| S-14 | Today's appointments and walk-ins in one timeline | P1 | Local | |
| S-15 | Staff break / unavailable status (affects ETA) | P2 | Local | |
| S-16 | History view: who did what to this visit, when | P1 | Local | From audit log |
| S-17 | Reminder when a guest has been in "serving" too long (forgot to complete) | P1 | Local | ★ Waitwhile and Qminder: staff forget to mark served, skewing data |
| S-18 | Edit service start/end times after the fact (with audit) | P1 | Local | ★ Qminder: times can't be corrected |
| S-19 | Destructive buttons separated and confirmable (end shift, remove guest) | P0 | Local | ★ Qminder: "pull shift" next to "end shift"; Waitwhile: checkmark dismissed guests by accident |
| S-20 | Works on iPad and Android tablets alike | P0 | Local | ★ Qminder dropped Android kiosk support; Waitwhile pulled its iOS app in Aug 2024 |

## 7. Wait-time estimation

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| W-1 | Estimate = sum of expected service durations ahead ÷ active servers | P0 | Local | |
| W-2 | Learn service duration from rolling history (median, per service, per time of day) | P1 | Local | SQL, no ML |
| W-3 | Factor in appointments blocking capacity | P2 | Effort | |
| W-4 | Track prediction error and show accuracy in analytics | P2 | Local | ★ QLess "wait times were WAY off" |
| W-5 | Manual override ("current wait is about 30 min") | P1 | Local | |
| W-6 | ML-based predictions | P3 | Effort | Only after enough data |

## 8. Appointments and bookings

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| A-1 | Public booking page per location/service | P1 | Local | |
| A-2 | Slot granularity any value from 5 min; slot start offsets | P1 | Local | ★ Waitwhile reviewer: only :00 and :30 |
| A-3 | Capacity per slot, per day, and per specific date | P1 | Local | ★ "Can't set different slot counts by day" |
| A-4 | Staff/resource availability calendars | P1 | Local | |
| A-5 | Buffers before/after, minimum notice, max days ahead | P1 | Local | |
| A-6 | Reschedule and cancel via guest link | P1 | Local | |
| A-7 | Reminders (24h, 1h) | P1 | Local | |
| A-8 | Unified list: appointments and walk-ins in one queue, with fairness rules | P1 | Effort | Waitwhile's core selling point |
| A-9 | Waitlist for full slots, auto-offer freed slots | P2 | Local | |
| A-10 | Group / class bookings and events with capacity | P2 | Local | |
| A-11 | Recurring appointments | P3 | Local | |
| A-12 | Google / Outlook calendar two-way sync | P2 | Effort | Free APIs, but OAuth app verification is slow |
| A-13 | Deposits / prepayment / card hold to cut no-shows | P2 | Paid | Stripe; test mode works locally for free. Yelp and Tock use card holds |
| A-14 | Block time in bulk (drag across calendar) | P2 | Local | ★ Manual blocking is slow per reviewers |
| A-15 | Appointment search across future dates | P2 | Local | ★ Reviewer complaint |
| A-16 | Calendar export (.ics feed) for staff | P1 | Local | ★ Waitwhile reviewer: no calendar sync or appointment export |
| A-17 | Visual resource planning view (staff × time grid) | P2 | Local | ★ Waitwhile reviewer asked for this |
| A-18 | Take payment at point of service | P3 | Paid | WaitWell sells this vs. Waitwhile |

## 9. Displays, kiosks, and hardware

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| D-1 | Waiting-room TV display (any browser): now serving, next up, counters | P0 | Local | Device role token |
| D-2 | Audio announcement on call (chime + text-to-speech) | P1 | Local | Web Speech API |
| D-3 | Display themes and branding; privacy mode (ticket numbers or first names only) | P1 | Local | |
| D-4 | Counter display (small screen above a desk) | P2 | Local | |
| D-5 | Kiosk mode (see J-4) with idle reset and printer support | P1 | Local | |
| D-6 | Ticket printing via browser print to thermal printer | P2 | Local | |
| D-7 | Direct ESC/POS printing (WebUSB / local print bridge) | P3 | Effort | |
| D-8 | Digital signage content (ads, announcements between calls) | P3 | Local | |
| D-9 | Accessible kiosk (audio guidance, high contrast) | P3 | Effort | Qmatic sells a tactile keypad for this |
| D-10 | Announcements in several languages and voices | P2 | Local | ★ Qwaiting reviewer: no human-voice caller, no French |

## 10. Analytics and reporting

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| R-1 | Today dashboard: waiting now, avg wait, served, no-shows | P0 | Local | |
| R-2 | Historical: wait time, service time, throughput, by day/hour | P1 | Local | Postgres views |
| R-3 | Abandonment and no-show rates | P1 | Local | |
| R-4 | Staff and counter performance | P2 | Local | |
| R-5 | Peak-hour heatmap and staffing suggestions | P2 | Local | |
| R-6 | Multi-location comparison | P2 | Local | |
| R-7 | CSV / JSON export of all data | P1 | Local | ★ No lock-in; Waitwhile gates export to Business |
| R-8 | Scheduled email reports | P2 | Paid | Uses the email provider |
| R-9 | Feedback / NPS reporting | P2 | Local | |
| R-10 | Custom report builder | P3 | Effort | |
| R-11 | Natural-language analytics ("why was Tuesday slow?") | P3 | Paid | LLM costs |

## 11. Customers (CRM)

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| C-1 | Guest profile created from visits (name, contacts) | P1 | Local | |
| C-2 | Multiple phones/emails per guest | P1 | Local | ★ Waitwhile allows one |
| C-3 | Visit history, repeat-guest recognition | P1 | Local | |
| C-4 | Tags and notes on guest | P2 | Local | |
| C-5 | Merge duplicates | P2 | Local | |
| C-6 | Import / export guests | P2 | Local | |
| C-7 | Consent tracking per channel | P2 | Local | Needed for SMS and GDPR |
| C-8 | Block list (abusive or fake joiners) | P2 | Local | |
| C-9 | Configurable data retention, never silently cleared | P1 | Local | ★ NextMe: event data cleared the next day |

## 12. Integrations and developer platform

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| I-1 | REST API (Supabase PostgREST + RLS gives this almost free) | P2 | Local | Waitwhile gates to Business |
| I-2 | Outgoing webhooks on visit events | P2 | Local | |
| I-3 | n8n / Zapier compatibility via webhooks | P2 | Local | n8n is self-hostable |
| I-4 | Slack / Discord / Teams alerts to staff | P2 | Local | |
| I-5 | API keys per org with scopes | P2 | Local | |
| I-6 | POS integrations (Square, Toast) | P3 | Effort | |
| I-7 | Salesforce / HubSpot | P3 | Effort | |

## 13. Branding and white-label

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| B-1 | Logo, colors, cover image on guest pages | P1 | Local | |
| B-2 | Custom welcome text, terms, privacy link | P1 | Local | |
| B-3 | Custom domain for guest pages | P2 | Paid | Cloudflare handles TLS free |
| B-4 | Remove product branding (white-label) | P3 | Local | |

## 14. Security, privacy, and compliance

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| X-1 | Postgres RLS on every tenant table, tested | P0 | Local | Highest-risk area in a multi-tenant Supabase app |
| X-2 | Rate limiting and abuse protection on public endpoints | P1 | Local | |
| X-3 | Minimal data on guests by default (first name + optional contact) | P0 | Local | |
| X-4 | Data retention settings (auto-anonymize after N days) | P2 | Local | Qminder gates to Premium |
| X-5 | GDPR: export and delete guest data on request | P2 | Local | |
| X-6 | Backups: scheduled pg_dump, restore drill | P1 | Local | Your responsibility when self-hosting |
| X-7 | Security headers, CSP, dependency scanning | P1 | Local | GitHub Dependabot |
| X-8 | HIPAA / SOC 2 | P3 | Paid | Out of scope; don't target healthcare records |

## 15. Platform and operations

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| P-1 | Supabase local stack in Docker (Postgres, Auth, Realtime, Storage, Edge Functions) | P0 | Local | |
| P-2 | Public reachability via Cloudflare Tunnel or free-tier host | P0 | Local | Guests on mobile data must reach the server |
| P-3 | PWA (installable, offline shell) | P0 | Local | Replaces native apps |
| P-4 | One-command self-host (`docker compose up`) with seed data | P1 | Local | Core of the open-source positioning |
| P-5 | i18n framework, RTL support | P1 | Local | |
| P-6 | Database migrations in repo (Supabase CLI) | P0 | Local | |
| P-7 | CI: lint, type-check, tests, RLS tests on GitHub Actions | P1 | Local | |
| P-8 | Error tracking and uptime monitoring | P2 | Paid | Sentry/GlitchTip; GlitchTip self-hosts locally |
| P-9 | Day rollover job (reset ticket counters, close stale visits) | P0 | Local | pg_cron |
| P-10 | Time zone and DST correctness tests | P1 | Local | Classic source of booking bugs |
| P-11 | Load test: 500 concurrent guests on status pages per location | P2 | Local | |

## 16. Monetization (only if it becomes a SaaS)

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| M-1 | Subscription billing per location, flat price, no visit metering | P3 | Paid | ★ Against Waitwhile's visit caps |
| M-2 | Free plan limits enforced in DB | P3 | Local | |
| M-3 | Hosted SMS credits at cost + small margin | P3 | Paid | |

---

## 17. Provider interfaces (built in phase 1, switched on in phase 3)

| ID | Feature | Pri | Cost | Notes |
|---|---|---|---|---|
| V-1 | Notification channel interface (send, status callback, inbound) with console/log provider | P0 | Local | Every channel (SMS, WhatsApp, email, push, Telegram) plugs in here |
| V-2 | Local email capture with Mailpit in docker-compose | P0 | Local | Real emails visible in a local inbox during development |
| V-3 | Fake SMS inbox page in dev (see what guests would receive, simulate replies) | P1 | Local | Lets you build two-way SMS before paying for it |
| V-4 | Payment provider interface with Stripe test mode | P2 | Local | Stripe test mode is free |
| V-5 | Per-message cost ledger (provider, segments, cost) per org | P2 | Local | Needed before SMS goes live, so spend is visible |
| V-6 | Per-org provider settings and secrets (platform account or own keys) | P2 | Local | Supabase Vault for secrets |
| V-7 | Usage limits and alerts per org per channel | P2 | Local | Avoid a surprise Twilio bill |

## Suggested MVP cut (P0 only)

One location, multiple queues and services, QR + link + staff-added joins, live status page with labelled ETA range and on-page alerts, web push, staff console (call, recall, undo, complete, no-show), audible staff alerts, TV display, today dashboard, RLS, Supabase in Docker, public tunnel, PWA, daily reset, and the notification provider interface with local stubs so SMS and email drop in later without a rewrite.

That is roughly 40 features. Ship it to one real business you know (a barber, a phone repair shop, a clinic front desk) before touching P1. Their feedback will reorder this list.

## Core data model sketch

`organizations` → `locations` → `queues` → `visits`
`services`, `resources` (staff, counters), `service_resources`
`visits`: id, queue_id, service_id, ticket_number, party_size, status, priority, position_key (for reordering), joined_at, called_at, served_at, completed_at, source (qr/kiosk/staff/web), guest_id, idempotency_key
`visit_events`: append-only log of every status change (audit + analytics)
`guests`, `guest_contacts` (many per guest), `consents`
`appointments`, `availability_rules`, `availability_exceptions`
`notification_templates`, `notifications` (channel, status, provider_id)
`devices` (kiosk/display tokens), `memberships` (user ↔ org ↔ role)
