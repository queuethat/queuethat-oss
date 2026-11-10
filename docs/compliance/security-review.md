# Security, privacy and compliance review

Reviewer role: security, privacy and compliance lead. Scope: `docs/research/feature-spec.md` and `docs/research/competitive-analysis.md` as of 2026-10-24. This is not legal advice. Items marked **[lawyer]** need a qualified lawyer before you rely on them.

## Verdict

The spec treats security as a module (section 14) rather than a property of every row. For a solo project whose code is written by agents, that is the most dangerous possible framing: agents implement what is written, and almost nothing in the P0 cut says what "secure" means in a testable way. The P0 exit criterion ("one real shop could run a day on it via a tunnel") puts an anonymous, internet-facing write endpoint into production, yet rate limiting, CAPTCHA, device auth, display privacy, accessibility and the audit log are all P1 or later. Fix the priorities and add the acceptance criteria in section 9 before writing a line of code.

The single biggest technical risk is not RLS on tables you remember. It is the Supabase defaults you forget: every table and function in `public` is reachable by the anon key through PostgREST, `SECURITY DEFINER` functions are executable by `anon` unless revoked, views and materialized views bypass RLS, and the self-host compose file ships with demo secrets.

---

## 1. Threat model (STRIDE, brief)

| Surface | Main threats | Required control |
|---|---|---|
| **Anonymous join page** (J-1, J-2) | **S**: join as someone else's phone number (harassment by SMS later). **T**: tampered payload (priority, party_size, queue_id of a closed queue). **D**: queue flooding with fake joins; SMS pumping in phase 3. **I**: page reveals other guests' names or counts beyond policy. | No direct table access for anon. One `join_queue` RPC/Edge Function that derives org/location from the queue's public slug, ignores client-supplied priority/status, checks queue open (Q-17), enforces rate limits and Turnstile, and returns only the guest's own token. |
| **Status page and visit token** | **S/I**: guessing or leaking a token exposes name, position, contact; **T**: anyone with the token can "leave queue" (G-3) or snooze. **R**: guest disputes "I never left". | 128-bit random token, stored as SHA-256 hash only, never the visit UUID or ticket number in the URL. `Referrer-Policy: no-referrer`. Token expires at visit end + N hours. Every guest action logged to `visit_events` with actor=`guest`. Status response contains no contact data, ever. |
| **Staff console** (S-*) | **E**: staff of org A reads org B; staff role does admin things (export, delete, role change). **R**: "who removed this guest?" on shared front-desk tablets. **I**: R-7 export and S-9 phone search as bulk exfiltration. | RLS by membership; role checks in DB, not UI. Audit log P0. Export owner/admin only, audited. Shared-tablet mode needs per-person PIN switch or accept that the audit trail says "front desk tablet". |
| **Device tokens** (ORG-8, D-1, J-4) | **S**: stolen display/kiosk token used from home to read the queue or create joins at scale. **E**: device token accepted as staff. **R**: no record of which device did what. | Pairing-code flow; token hashed at rest; scoped to one location and one role (`display` read-only sanitized view, `kiosk` join-only); revocable from the console; last-seen IP/UA shown; rate limits per device. Use `app_metadata` claims, never `user_metadata` (user-editable). |
| **Realtime channels** | **I**: can a guest subscribe to another tenant's `visits` changes? With `postgres_changes`, an anon client subscribes with a filter it chooses; RLS is the only gate, and anon has no tenant identity. DELETE events are not RLS-filtered. **D**: thousands of subscriptions per queue. | Guests and displays never use `postgres_changes` on base tables. Use private Broadcast channels with Realtime Authorization (RLS on `realtime.messages`), or a public channel keyed by an unguessable queue id that carries only a version counter and "now serving A012", after which the client re-fetches its own status via RPC. Staff may use `postgres_changes` with RLS. |
| **Edge Functions** | **S**: functions deployed with `--no-verify-jwt` by an agent "to make it work". **E**: service-role client used where a user-scoped client was enough. **I**: PII in function logs. | Each function declares auth mode in a manifest checked in CI. Service-role client only in an allowlisted set of functions. Structured logging with phone/email redaction. |
| **Provider webhooks** (phase 3) | **S**: forged Twilio/Stripe/Meta callbacks mark messages delivered, opt guests in, or confirm payments. **T/R**: replays. | Verify `X-Twilio-Signature`, `Stripe-Signature` (with timestamp tolerance), `X-Hub-Signature-256`. Idempotency on provider event id. Reject unsigned before any DB write. |
| **Self-host distribution** (P-4) | **E**: default `JWT_SECRET`, anon/service keys and Studio dashboard credentials from Supabase's example compose; Studio, Kong admin or Postgres 5432 exposed through the tunnel. **T**: supply chain (compromised image or npm dep). | Install script generates secrets; app refuses to boot if any known demo key is present. Tunnel config exposes only the app and the API gateway routes it needs. Signed release images, pinned digests, SBOM. |

## 2. Multi-tenant isolation

**RLS pattern.** Every tenant table carries `org_id NOT NULL` (and `location_id` where relevant, because ORG-10 per-location assignment at P2 is painful to retrofit). Policies call one helper, e.g. `private.has_role(org_id, location_id, min_role)`, which is `SECURITY DEFINER`, `STABLE`, `SET search_path = ''`, and reads `memberships` by `auth.uid()`. Wrap `auth.uid()` as `(select auth.uid())` in policies for plan caching. Separate policies per command; every `INSERT`/`UPDATE` policy has a `WITH CHECK` that pins `org_id`, so a staff member cannot move a row to another tenant. Child tables (visits) must check the parent's org, or carry a denormalized `org_id` enforced by a trigger or composite FK `(queue_id, org_id)`; I prefer the composite FK because it is impossible to get wrong at write time.

**Default privileges.** Revoke `ALL` on schema `public` tables from `anon`, and grant back only what is designed. Better: put base tables in a non-exposed `app` schema and expose a narrow `api` schema of views (`security_invoker = true`) and RPCs to PostgREST. This also makes I-1 ("REST API almost free") a deliberate surface instead of "our whole schema is the API".

**Security-definer rules** (encode as CI checks, not prose):
1. Lives in a non-exposed schema unless it is an intentional public RPC.
2. `SET search_path = ''` and fully qualified names.
3. `REVOKE EXECUTE ... FROM PUBLIC, anon` then grant explicitly.
4. Re-checks the caller's authorization inside the body; never trusts parameters for `org_id`.
5. Listed in an allowlist file reviewed by a human. Agents may not add to it without a flagged PR.

**Views and analytics.** R-2 says "Postgres views". Plain views run as owner and bypass RLS; materialized views have no RLS at all. Rule: all views `security_invoker = true`; materialized views live in a non-exposed schema and are read only through RPCs that filter by org.

**pgTAP strategy (X-1, P-7).** Two layers.
- *Structural tests* that fail the build: any table in exposed schemas without `relrowsecurity`; any RLS-enabled table with zero policies; any `SECURITY DEFINER` function without `search_path` in `proconfig`; any function executable by `anon` not in the allowlist; any view without `security_invoker`; any table missing `org_id` not on an explicit global allowlist. These catch the agent who adds a table and forgets.
- *Behavioural matrix*: fixtures with two orgs, each with owner/admin/staff/display/kiosk, plus anon and a guest token. For every table × role × {select, insert, update, delete}, assert the expected row count or `42501`. Generate the matrix from a YAML spec so new tables must declare expected access. Include Realtime: a test that a guest-scoped JWT cannot be authorized on another org's private channel topic.

**Storage.** Logos/cover images (B-1): public bucket, path `org/{org_id}/branding/*`, write policy by admin role, MIME allowlist (png/jpeg/webp; no SVG, which carries script), size cap. Q-8 "file" intake fields: private bucket, path prefixed by org and visit, read by staff of that org only, signed URLs ≤5 min. I recommend cutting the file field type entirely (see clinic section).

**Service-role key.** Lives only in Edge Function secrets and the migration runner. CI greps the built frontend bundle for `service_role`, `sb_secret_` and the JWT secret and fails on a hit. Rotation runbook documented. Self-hosters: generated per install, never in the repo, never in seed data.

## 3. Privacy

**PII inventory (initial).**

| Data | Where | Sensitivity | Default retention I recommend |
|---|---|---|---|
| Guest first name | `guests`, `visits` | Personal | Anonymize 30 days after visit |
| Phone, email | `guest_contacts` | Personal, contact | Delete 30 days after last visit unless the guest has a profile the business needs (C-1) |
| Custom field answers (Q-8) | visit answers | Unknown, can be special category | 30 days |
| Staff notes/tags (S-8, C-4) | visits, guests | Free text, high risk (opinions, health) | Same as visit |
| Feedback and chat (G-11, G-15) | new tables | Free text | 90 days |
| IP, user agent, device idempotency key (J-12) | rate-limit store, logs | Personal under GDPR | 7–30 days |
| Consent records (C-7) | `consents` | Evidence | Keep for limitation period after revocation **[lawyer]** (TCPA claims: 4 years) |
| Staff accounts | Auth, memberships | Personal | Life of account + audit retention |
| Audit log | `visit_events`, audit table | Contains actor ids | 1–2 years, pseudonymize guest fields on anonymization |

**Minimization (X-3).** Good default. Make it structural: phone/email optional at the schema level, no last name field in templates, and ETA/analytics must work on anonymized rows (store `party_size`, timestamps, service, never names, in the analytics path).

**Retention (C-9 vs X-4).** These contradict. C-9 (P1) says "never silently cleared", X-4 (P2) says auto-anonymize. Merge into one P1 feature: retention is *on by default* (template-driven, e.g. 30 days for contacts), visible in settings, shown in the privacy notice, and anonymization keeps statistical rows. "Never silently" means it is announced, not that it never happens. Keeping guest phone numbers forever by default is a GDPR storage-limitation breach for every EU customer and a breach-impact multiplier for everyone.

**GDPR / UK GDPR.** For self-host, the business is controller and you are nobody (no data reaches you), which is the cleanest position you will ever have; keep it that way (no phone-home telemetry without opt-in). If you host, you become processor: you need a DPA, a public subprocessor list (Supabase, Cloudflare, email provider, Twilio/Meta, Stripe, error tracker), SCCs/UK IDTA for transfers, a breach procedure that can notify controllers fast enough for their 72-hour clock, and records of processing **[lawyer]**. Lawful basis for the queue itself is usually contract or legitimate interest; marketing needs consent. X-5 export/delete must cover guests, contacts, answers, notes, notifications, consents (delete except evidence) and storage files, and must be a P1, not P2, because the first EU guest who asks makes it mandatory.

**CCPA/CPRA.** Most barbers will be below thresholds; a hosted SaaS acts as a service provider and needs contract terms restricting use **[lawyer]**. Practical requirement: no selling/sharing, which J-19 pixels arguably are.

**J-19 pixels.** Recommend cutting. If kept: off by default; never on the status page; consent banner with reject as prominent as accept (ePrivacy/PECR prior consent); no queue, service or custom-field data in events; hard-disabled for any org using a clinic/health template. Meta and Google pixels on health-adjacent pages have produced FTC actions (GoodRx, BetterHelp) and HHS guidance on tracking technologies. This feature turns a privacy-respecting product into a liability for a P3 request from one reviewer.

**Displays (D-1, D-3, D-2).** A waiting-room TV that shows full names next to a service is a disclosure to everyone in the room, and TTS announcing names is the same in audio. Privacy mode cannot be P1 when the display is P0. Default must be ticket number only; first name opt-in per location with a warning; service name hidden on public surfaces by default; clinic templates lock names off the display.

**Clinics.** X-8 says "don't target healthcare records" while ORG-14 ships a clinic template and the MVP is meant for "a clinic front desk". Under HIPAA, PHI is individually identifiable information held by a covered entity relating to health or care; the fact that a named person is in a clinic's queue, plus a service like "vaccination" or "lab draw", is plausibly PHI, and a vendor hosting it for the clinic is a business associate needing a BAA **[lawyer]**. In the EU/UK it is special-category data (Art. 9). "Reason for visit" turns this from plausible to certain. Guardrails:
- Clinic template: ticket numbers only on displays, no free-text reason field, services named generically ("Appointment", "Walk-in") by default.
- Q-8 builder shows a warning when a field label matches health terms (symptom, reason, condition, medication, insurance, DOB) and on any free-text field in a health-tagged org.
- Drop the `file` field type (insurance cards, referral letters will arrive).
- Hosted ToS: no PHI unless a BAA is signed, and you won't sign one. Self-host docs: a plain statement that HIPAA compliance is the operator's responsibility.
- Do not repeat Waitwhile's "HIPAA-ready" claim anywhere in marketing.

## 4. Messaging compliance (phase 3, designed now)

**US SMS.** TCPA requires prior express consent for automated informational texts to mobiles and prior express *written* consent for marketing. A guest typing their number into a "text me when it's my turn" field, with clear disclosure, is generally consent for transactional messages about that visit; it is not consent for "come back next week, 10% off" **[lawyer]**. Consent revocation must be honored by any reasonable means (FCC 2024 order; parts of its implementation were delayed, check status) **[lawyer]**. State laws (Florida FTSA, Oklahoma) add quiet hours and stricter rules; enforce a default 8am–8pm recipient-local quiet window for anything non-urgent, with "you're called" exempt because the guest asked for it now.

**10DLC.** US carriers block unregistered A2P traffic. Decide the sender model now: platform-as-ISV with one brand per business (correct, slow, each business needs an EIN), or bring-your-own Twilio account (V-6; the business owns the registration). For self-host, BYO is the only sane default. Campaign registration needs sample messages, opt-in flow description and screenshots, so the join page copy is a compliance artifact; version it.

**STOP/HELP.** Twilio Messaging Services auto-handle standard keywords, but your DB must also record the opt-out (inbound webhook) so you stop *attempting* sends and show "opted out" to staff. Support STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, and START/UNSTOP; HELP returns business name and contact. Opt-out is per sender number, per org; staff cannot override it. Beware N-7: "C" to confirm and "L" to leave must not collide with carrier keywords.

**SMS pumping.** Public join + SMS = toll fraud target. V-7 usage caps and country allowlists are a phase-3 launch gate, not P2.

**Email (CAN-SPAM, PECR).** Transactional queue emails are largely exempt, but headers must be accurate. Anything promotional needs unsubscribe and a physical postal address; in the UK/EU, soft opt-in rules apply **[lawyer]**.

**WhatsApp.** Meta requires opt-in naming the business and WhatsApp as the channel; business-initiated messages outside the 24-hour window need approved templates categorized utility vs marketing.

**Phase 1 schema so phase 3 needs no migration nightmare:**
- `guest_contacts`: `channel`, `value_e164` (normalized at write), `country_code`, `verified_at`, `created_source` (guest/staff/kiosk/import).
- `consents`: `org_id`, `contact_id`, `channel`, `purpose` (`transactional`/`marketing`), `status` (`granted`/`revoked`), `captured_at`, `source`, `consent_text_version`, `consent_text_hash`, `locale`, `captured_by_user_id` (staff-entered, J-3, requires staff attestation checkbox), `ip_hash`, `revoked_at`, `revoked_via` (stop_keyword/link/staff/api).
- `suppressions`: `org_id`, `channel`, `value_e164`, `reason`, `created_at`. Checked by the notification dispatcher before every send, including in the console stub.
- `notifications`: `idempotency_key`, `consent_id`, `template_id`, `template_version`, `category`, `provider`, `provider_message_id`, `status`, `error_code`, `segments`, `cost_micros`, `currency`, `scheduled_for`, `sent_at`, `quiet_hours_deferred`.
- `inbound_messages`: raw payload, signature-verified flag, matched contact.
- `notification_templates.category` (transactional/marketing) and locale.
- `organizations`: `legal_name`, `postal_address`, `support_contact`, `messaging_brand_ref`. Locations already have timezone; use it for quiet hours.

The V-1 console stub must run the same consent/suppression/quiet-hours checks as real providers, so phase 3 flips a provider, not a policy.

## 5. Accessibility as compliance

- **ADA Title III**: US courts routinely treat business websites as covered; the businesses (your users) get sued, and they will blame the tool. Join, status, booking and kiosk pages are the exposure.
- **ADA Title II**: DOJ's 2024 rule requires state and local government web content and apps to meet WCAG 2.1 AA, with deadlines from April 2026 (larger entities) and 2027 (smaller) **[lawyer for current status]**. You name small government and education offices as targets. For them, G-10 is a procurement prerequisite.
- **European Accessibility Act**: applies since 28 June 2025. Its scope explicitly includes self-service terminals such as ticketing and check-in machines, and consumer e-commerce services. A kiosk-mode queue ticket terminal is close to the definition; whether software on a generic tablet makes you a "manufacturer" is unsettled **[lawyer]**. Microenterprises are exempt for services, not wholly for products. Harmonized standard EN 301 549 (WCAG 2.1 AA plus terminal requirements).

Queue-specific failures to design out: being called only by sound (G-5, D-2) or only visually, excludes deaf or blind guests; provide both plus vibration. Auto no-show (Q-13) and kiosk idle reset (J-4) are time limits (WCAG 2.2.1): warn and allow extension. Turnstile must use its non-interactive mode with an accessible fallback. Live position updates need `aria-live="polite"` without spamming. Move G-10 to P0 for guest-facing pages; D-9 accessible kiosk from P3 to P2.

## 6. Abuse

- **Fake joins / flooding.** P0: per-IP and per-queue rate limits, Turnstile (or a self-hostable alternative such as a proof-of-work challenge, because an open-source product must not hard-depend on Cloudflare), per-queue capacity (Q-6 should be P0), staff bulk-remove of joins from the last N minutes.
- **Remote joins.** Q-14 geofence is weak (spoofable, needs permission). Better and cheap: an optional "on-site code" shown on the TV display, rotating every few minutes, required to join. Keeps J-2 printed URLs stable.
- **Enumeration.** No sequential ids or ticket numbers in URLs. Queue public slugs are fine to be guessable (they're on posters); visit tokens are not. Status endpoint returns identical 404 for unknown and expired tokens and is rate-limited.
- **Rate limiting reality.** PostgREST has no per-IP limiting. Put the anon join path behind an Edge Function or reverse-proxy rule, with a Postgres-backed counter as a backstop. Behind a tunnel, trust `CF-Connecting-IP`/`X-Forwarded-For` only from the proxy.
- **Block list (C-8)** P2 to P1: by phone hash and device key, per org. Auth (ORG-1): enable Supabase Auth rate limits and CAPTCHA on sign-up and magic link, otherwise you are a free email-bombing relay once email goes live.

## 7. Licensing

Recommend **AGPL-3.0** for the server and web app. Given "self-hostable now, maybe hosted SaaS later", MIT/Apache lets any competitor (including Allegion/Waitwhile) host your code as a service without sharing changes. AGPL closes that, has a direct precedent in your space (Cal.com), and still allows unlimited self-hosting by businesses. The cost: some companies ban AGPL internally; your target users (barbers, clinics, offices) don't care.

Decide now whether you might ever sell a commercial licence or relicense. If yes, require a CLA from day one; if not, use DCO sign-off. Agent-written code adds a wrinkle: largely AI-generated code may have thin copyright protection, which weakens any licence's enforceability **[lawyer]**. Keep meaningful human authorship in the record.

Dependency hygiene: CI licence allowlist (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, GPL-3.0/LGPL compatible with AGPL); deny SSPL, BUSL, Commons Clause, CC-BY-NC, "no licence". GitHub dependency-review action with `allow-licenses`, CycloneDX SBOM per release, Dependabot plus `npm audit`/OSV in CI, pinned image digests. Check fonts, icon sets, and notification sounds too; they're where licences go unread.

## 8. Flaws, gaps and wrong priorities

**Priority changes (risk-driven):**

| ID | Now | Should be | Why |
|---|---|---|---|
| J-11, X-2 | P1 | P0 | P0 exit puts an anonymous write endpoint on the internet |
| ORG-8 (device role) | P1 | P0 | D-1 is P0 and already depends on "device role token"; inconsistent |
| D-3 privacy mode | P1 | P0 default | Names on a public TV is a disclosure on day one |
| ORG-11 audit log | P1 | P0 | Admin actions (role change, device issue/revoke, export, delete) need it from the first real shop; `visit_events` only covers visits |
| G-10 accessibility | P1 | P0 for guest pages | Retrofitting a11y is far costlier; Title II/EAA exposure |
| X-7 headers/CSP | P1 | P0 | Cheap, and CSP is harder to add later |
| Q-6 capacity | P1 | P0 | Simplest anti-flood control |
| C-9 + X-4 | P1/P2 | Merge, P1, on by default | Contradictory as written |
| X-5 export/delete | P2 | P1 | Required on first request from an EU/UK guest |
| C-8 block list | P2 | P1 | Abuse arrives before parity |
| ORG-13 2FA | P2 | P1 for owner/admin | Owner account holds every guest's phone |
| V-7, N-13 | P2 | Hard gate on enabling any Paid channel | SMS pumping, TCPA |
| D-9 | P3 | P2 | EAA terminals |
| J-19 | P3 | Cut, or heavily fenced | Liability > value |

**Gaps (no row exists):**
- SECURITY.md, vulnerability disclosure, `security.txt`, private advisory process.
- Secret generation and default-secret refusal for self-host (P-4).
- Org deletion and staff offboarding (session revocation, device revocation).
- Shared-tablet staff identity (PIN switch) for meaningful audit.
- PII-redacted logging for Edge Functions and error tracking (P-8 will ship phone numbers to Sentry otherwise).
- Backup encryption and backup retention aligned with deletion (X-6): a deleted guest lives on in last month's dump; document it.
- Breach response runbook (hosted: controller notification).
- Children: education offices and families (Q-7, J-14) will queue minors; no specific design needed beyond minimization, but don't add DOB fields.
- Telemetry policy for self-host: none by default.
- Staff notes (S-8), chat (G-15), feedback (G-11): free text included in export/delete and retention.
- R-7 export: owner/admin only, audited, rate-limited, not available to device roles.
- S-9: staff role sees masked phone (last 4) unless needed.
- pg_cron jobs (P-9) run privileged; they must not be callable via RPC.

## 9. Acceptance criteria for GitHub issues

### Phase 1 (P0, before any tunnel exposure)

- [ ] CI pgTAP test fails if any table in an API-exposed schema has RLS disabled or has zero policies.
- [ ] CI pgTAP test fails if any `SECURITY DEFINER` function lacks `search_path` in `proconfig`, or is executable by `anon`/`PUBLIC` without being listed in `db/security-definer-allowlist.txt`.
- [ ] CI pgTAP test fails if any view in an exposed schema lacks `security_invoker = true`, or any materialized view is in an exposed schema.
- [ ] Access matrix (`tests/rls/matrix.yaml`) covers every tenant table for roles anon, guest-token, staff/admin/owner of org A, staff of org B, display, kiosk; test fails when a new table has no matrix entry.
- [ ] Staff of org B receive zero rows and `42501` on write for every org A table (matrix-asserted).
- [ ] `INSERT`/`UPDATE` policies include `WITH CHECK` preventing change of `org_id`; test attempts to move a visit across orgs and expects failure.
- [ ] `anon` has no `SELECT/INSERT/UPDATE/DELETE` grant on any base table (asserted via `information_schema.role_table_grants`).
- [ ] Guest join goes through a single `join_queue` endpoint; client-supplied `priority`, `status`, `org_id`, `ticket_number` are ignored (test sends them and asserts server values).
- [ ] Join to a closed or paused queue returns an error from every entry point: page, kiosk, staff-add (Q-17), tested per source.
- [ ] Visit token: ≥128 bits from a CSPRNG, stored only as a SHA-256 hash, absent from logs; test asserts no plaintext token column.
- [ ] Status endpoint returns no phone/email/custom-field data; returns identical 404 for unknown vs expired tokens; token invalid 12h after terminal status.
- [ ] Guest and display clients cannot subscribe to `postgres_changes` on `visits`; a test with the anon key subscribing to another org's queue receives no payloads.
- [ ] Realtime channels used by guests/displays carry no names or contact data (payload schema test).
- [ ] Device pairing: one-time code expiring in 10 minutes; issued token scoped to one location and role; stored hashed; revocation takes effect within 60s (test).
- [ ] Display role can read only the sanitized display view; kiosk role can only call `join_queue` for its location (matrix-asserted).
- [ ] Display default shows ticket numbers only; names require an explicit per-location setting; clinic template cannot enable names.
- [ ] Join endpoint enforces per-IP (default 10/10min) and per-queue (default 60/min) limits and a CAPTCHA verifier interface with Turnstile and a no-third-party option; test exceeds the limit and gets 429.
- [ ] Queue capacity limit enforced in DB.
- [ ] Audit table records actor, role, org, action, target, before/after for: membership/role changes, device issue/revoke, queue settings, visit removal, exports, data deletion. Append-only: `UPDATE`/`DELETE` revoked from all app roles (test).
- [ ] Security headers on all pages: CSP without `unsafe-inline` scripts, `frame-ancestors 'none'` (except the future widget route), HSTS, `Referrer-Policy: no-referrer` on guest routes, `X-Content-Type-Options: nosniff` (test via HTTP assertions).
- [ ] Frontend build fails if bundle contains `service_role`, `sb_secret_`, or the JWT secret.
- [ ] Every Edge Function declares `auth: jwt|public|webhook` in a manifest; CI fails on `--no-verify-jwt` for functions not marked `public`/`webhook`.
- [ ] Guest join and status pages pass axe-core with zero serious/critical violations in CI; called state is announced via visual, audio and vibration; status updates use `aria-live="polite"`.
- [ ] Phone/email optional in schema; no last-name or DOB field in any template.
- [ ] Phase 3 tables exist: `consents`, `suppressions`, `inbound_messages`, `notifications` with fields listed in section 4; console provider refuses to send without a matching consent and checks suppressions (test).
- [ ] Self-host install generates unique JWT secret, anon/service keys, DB and dashboard passwords; app refuses to start if any known Supabase demo key is configured (test).
- [ ] Tunnel example config exposes only the web app and required API routes; Studio and port 5432 not reachable (documented check).
- [ ] `SECURITY.md` with private reporting channel; licence file (AGPL-3.0); dependency-review action with licence allowlist.

### Phase 2 (before a second business)

- [ ] Retention: per-org setting, default 30 days for contacts and custom answers; nightly job anonymizes names, deletes contacts, keeps statistical fields; test with frozen clock.
- [ ] Settings page and guest privacy notice display the active retention period.
- [ ] Guest data export (JSON) and delete by phone/email cover guests, contacts, visits, answers, notes, chat, feedback, notifications, storage files; consent evidence retained, marked revoked; audited.
- [ ] R-7 bulk export limited to owner/admin, audited, rate-limited to N per day.
- [ ] TOTP 2FA available; org setting to require it for owner/admin.
- [ ] Block list by phone hash and device key; blocked joins get a generic error.
- [ ] Q-8 builder warns on health-related labels and on free-text fields in health-tagged orgs; no `file` field type.
- [ ] Storage buckets: branding public, MIME allowlist excluding SVG, ≤2MB; private buckets path-prefixed by `org_id` with policies tested in pgTAP.
- [ ] Kiosk and status time limits warn ≥20s before expiry and allow extension (WCAG 2.2.1).
- [ ] Full WCAG 2.1 AA manual audit of guest, kiosk and booking flows, with a published accessibility statement.
- [ ] Edge Function and error-tracker logs redact E.164 numbers and emails (test with a fixture log line).
- [ ] Org deletion removes all tenant rows and storage within 30 days; staff removal revokes sessions and device tokens they issued are listed for review.
- [ ] CycloneDX SBOM attached to each release; images signed and pinned by digest.

### Phase 3 (gate before any Paid channel goes live)

- [ ] Webhooks reject requests with invalid Twilio/Stripe/Meta signatures before any DB write; replayed event ids are no-ops (tests with recorded fixtures).
- [ ] STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT create a suppression within one webhook call; START/UNSTOP removes it; HELP returns business name and contact; staff cannot send to a suppressed number.
- [ ] Non-urgent messages deferred outside 08:00–20:00 location local time; "called" notification exempt; test across DST.
- [ ] Marketing-category templates require a `marketing` consent; transactional consent alone blocks them (test).
- [ ] Staff-added contacts (J-3) require an attestation that the guest agreed, recorded on the consent row.
- [ ] Per-org daily SMS cap and country allowlist enforced before provider call; alert at 80%.
- [ ] Join page consent copy versioned; consent row stores version and hash.
- [ ] WhatsApp sends outside 24h window only via approved templates; opt-in recorded with channel `whatsapp`.
- [ ] Promotional email includes unsubscribe link and org postal address; unsubscribe honored immediately.
- [ ] Hosted only: DPA, subprocessor list and privacy policy reviewed by a lawyer **[lawyer]**; ToS forbids PHI.
