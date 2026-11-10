# Pilot deploy checklist

O4 (#75) fills in the deploy workflow. These settings are prerequisites for launch, and each one
is required before the pilot takes real guests.

## Vercel hosting

`vercel.json` builds `apps/web` and serves it with the same headers as `apps/web/public/_headers`
(which Vercel ignores) plus a single-page-app rewrite; `vercel-config.test.ts` keeps the two in step.
`development` deploys to the sandbox (Vercel preview) and `main` to production. Set
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and the optional `VITE_*` keys per environment in
Vercel, pointing each at its own Supabase project.

## Production auth: apply in this order (launch)

Dashboard settings only the maintainer can change, in the production project. Details for each are in the
sections below; this is the order and the pass/fail check.

- [ ] **1. Site URL and redirect URLs** (Authentication → URL Configuration). Site URL
      `https://app.queuethat.com`; Redirect URLs `https://app.queuethat.com/**`. Until this is set,
      every confirmation, invite and reset link points at localhost. Check: sign up with a real
      inbox and open the link.
- [ ] **2. Custom SMTP** (Authentication → Emails → SMTP Settings; see "Custom SMTP"). Without it
      hosted Auth sends a handful of emails an hour, so sign-ups fail on day one.
- [ ] **3. Email rate limit to 300 per hour** (Authentication → Rate Limits). Confirm the email
      provider's plan allows it.
- [ ] **4. Templates** (Authentication → Emails → Templates): Magic Link, Confirm signup, Reset
      Password, and Invite user, each pasted from `supabase/templates/`. Paste the subjects from
      `supabase/config.toml` too (`[auth.email.template.*]`): the Magic Link and Invite subjects
      are templates that name the business. Magic Link has an invitation variant, because an
      existing user's invitation goes out as a magic link (#1108). Check: invite a new address
      and an existing account; both emails name the business and neither shows a sign-in code
      for the existing user.
- [ ] **5. JWT expiry 300 seconds** (Authentication → Sessions / JWT settings). The default is
      3600, so a signed-out tablet keeps working for an hour.
- [ ] **6. Secure password change** on (Authentication → Providers → Email).
- [ ] **7. Turnstile, in this order:** set `VITE_AUTH_TURNSTILE_SITE_KEY` in Vercel and redeploy
      first, then turn on Auth CAPTCHA (Authentication → Attack Protection). The other order
      breaks sign-in for everyone. See "CAPTCHA on sign-in and sign-up".
- [ ] **8. Prove it:** run `scripts/check-otp-rate-limit.mjs` and `scripts/check-auth-captcha.mjs`
      against production (commands below), then sign in and sign up once in a real browser.

## Supabase project settings

- [ ] **Realtime: private channels only** (#457). In the dashboard, go to Realtime → Settings and
      turn off **Allow public access to channels**. On a public channel, a topic name is enough
      to listen in or broadcast, which skips the `realtime.messages` policies that keep staff
      signals away from guests and stop forged pulses (I-5). The app already opens every
      channel as private: ESLint lets only `apps/web/src/lib/realtime.ts` open one, and
      `realtime.test.ts` checks it passes `private: true`. Turning public access off breaks
      nothing.
  - Scripted alternative: the Management API schema bundled with the Supabase CLI has
    `private_only` on `PATCH /v1/projects/{ref}/config/realtime`. Supabase's docs don't list it
    yet, so confirm the dashboard toggle changed afterwards.
  - Self-hosted Realtime: set `private_only = true` on the tenant's row in
    `_realtime.tenants`. Realtime caches tenants, so allow about 20 seconds before it takes
    effect.
- [ ] **Check it took effect.** Open an anon `channel('probe', { config: { private: false } })`
      and subscribe. The subscription must fail with `PrivateOnly`.
- [ ] Remember that private-only is only as strong as the `realtime.messages` SELECT policies
      (`follow_queue_pulse`, `follow_location`) and the absence of an INSERT policy. Any change
      to them needs a security review.
- [ ] **Auth emails carry the 8-digit code** (A1 follow-up). In the dashboard, go to
      Authentication → Emails → Templates and paste `supabase/templates/magic_link.html` into
      **Magic Link** and `supabase/templates/confirmation.html` into **Confirm signup**. The
      default templates contain only the link, and the link works only in the browser that
      asked for it (PKCE). Without the code, someone who opens the email on their phone can't
      sign in on the shop's tablet.
  - Check: request a sign-in email and confirm it shows an 8-digit code that signs in from
    another device.
- [ ] **Password reset (#1076).** In Authentication → Emails → Templates, paste
      `supabase/templates/recovery.html` into **Reset Password**, with the subject "Reset your
      QueueThat password". Under Authentication → URL Configuration, check that Redirect URLs
      cover `/auth/callback` on the app host, for example `https://app.queuethat.com/**` (and
      `https://app.dev.queuethat.com/**` on dev); the recovery link returns to
      `/auth/callback?next=/auth/reset-password`.
  - Also turn on **Secure password change** (Authentication → Providers → Email), to match
    `secure_password_change = true`, and enable CAPTCHA first: the reset form can mail any
    address, and the hourly `email_sent` cap would otherwise let a script block real resets.
  - Check: on `/auth/sign-in` choose "Forgot password?", request a reset, and confirm the email
    shows an 8-digit code that opens the new-password screen from another device.
- [ ] **Sign-in codes are 8 digits and expire in 10 minutes** (#509 security review). Under
      Authentication → Providers → Email, set the email OTP length to 8 and the expiry to 600
      seconds, to match `supabase/config.toml` and `SIGN_IN_CODE_LENGTH` in
      `apps/web/src/features/auth/api.ts`. The app's code field accepts exactly that many digits.
      The review found that GoTrue keeps accepting guesses against a code (the right code still
      worked after 60 wrong ones) and that the local stack never returned 429 on
      `POST /auth/v1/verify`. So length and expiry are what bound brute force.
  - **Prove the per-IP limit works:** run
    `AUTH_URL=https://<ref>.supabase.co/auth/v1 APIKEY=<publishable key> node scripts/check-otp-rate-limit.mjs`
    from a machine that isn't on the shop's network. It must print two `ok` lines: wrong
    codes from one IP get HTTP 429, and so do wrong codes sent with made-up
    `X-Forwarded-For` / `X-Real-IP` headers.
  - Hosted: if it fails, lower the token-verification limit under Authentication → Rate
    Limits and run it again.
  - Self-hosted: GoTrue applies its `RATE_LIMIT_VERIFY` limit only when
    `GOTRUE_RATE_LIMIT_HEADER` names a header that holds the client IP. Without it, every limit
    is skipped silently. Point it at a header that your edge proxy **overwrites** from the
    socket address, for example `X-Real-IP` with nginx `proxy_set_header X-Real-IP $remote_addr;`.
    Never point it at a header that passes client values through, or one made-up header per
    request bypasses the limit. Make GoTrue and Kong reachable only through that proxy:
    a client that reaches GoTrue directly can set the header itself. Then run the check script
    against the public URL before sign-off.
  - Why local can't show this: the Supabase CLI doesn't set `GOTRUE_RATE_LIMIT_HEADER` and has no
    `config.toml` key for it, so the local stack never returns 429, whatever `[auth.rate_limit]`
    says. #509 has the evidence: the script fails on the CLI stack, passes against the same
    GoTrue behind an overwriting proxy, and fails behind a pass-through proxy.
- [ ] **Authenticator-app MFA is on, and wrong codes lock the account** (PLT11, #417). A business
      that requires MFA of its owners and admins treats them as managers until their session is aal2.
  - Under Authentication → Multi-Factor, enable TOTP (app authenticator) for enrolment and
    verification, to match `[auth.mfa.totp]` in `supabase/config.toml`.
  - **Per-account lockout.** A TOTP code is 6 digits and Auth accepts the codes either side of
    the current one, so a stolen password plus unlimited guesses would get through. The MFA
    verification hook `private.mfa_verification_attempt` rejects every code for an account
    after 5 wrong ones in 15 minutes, from any IP, and Auth then ends that session. Enable it
    under Authentication → Hooks → MFA verification attempt, Postgres function
    `private.mfa_verification_attempt` (self-hosted: `GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED=true`
    and `GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_URI=pg-functions://postgres/private/mfa_verification_attempt`,
    as in `config.toml`). Supabase lists this hook for Team and Enterprise plans only (check before launch). On a plan
    without it, the per-IP MFA limit below is the only defence, so get that check passing first.
  - **Per-IP limit.** Hosted: keep the MFA limit under Authentication → Rate Limits at its
    default or lower. Self-hosted: `GOTRUE_MFA_RATE_LIMIT_CHALLENGE_AND_VERIFY` has the same
    `GOTRUE_RATE_LIMIT_HEADER` requirement as above and is skipped without it.
  - **Prove it:** create a test account with no authenticator app (not a real operator: the
    run locks it for 15 minutes), then run
    `MFA_EMAIL=<test account> MFA_PASSWORD=... AUTH_URL=https://<ref>.supabase.co/auth/v1 APIKEY=<publishable key> node scripts/check-otp-rate-limit.mjs`.
    It must print two `ok` lines, each saying whether the per-account lockout or HTTP 429 stopped
    it. Locally it passes through the lockout; 429 never appears locally, for the reason above.
  - **Session time limit.** Removing the app asks for a fresh code, but that check is in the
    browser only, so a stolen signed-in browser must stop being useful. Everyone who signs in
    (owners, staff, operators) is signed out 12 hours after signing in, or after 30 minutes
    without using the app. Paired displays and kiosks are exempt. This is our own cron job
    (`ops.end_expired_sessions`) and `api.touch_session`, not GoTrue's timebox, which would sign
    out every TV. Do not set GoTrue's inactivity timeout or time-box. Set the project's JWT
    expiry to 300 seconds (Authentication → Sessions / JWT settings; `jwt_expiry` in
    `config.toml` covers local and self-host), or an ended session's access token stays valid for
    up to an hour. Check: sign in, leave the tab alone for 35 minutes, and the next click
    returns to sign-in.

Local development matches production. The CLI's `config.toml` has no setting for this, so e2e
global setup turns on `private_only` for the local Realtime tenant
(`tests/e2e/support/realtime.ts`), and `tests/e2e/realtime-private.spec.ts` proves it holds.

## Edge rate rule on guest joins

`api.join_queue` is the one anonymous write. The database already limits joins per device, per
network and per queue, and answers `rate_limited`. The edge rule (O5, #76) turns a flood away at
the gateway, before it costs PostgREST and Postgres anything. It allows 30 joins a minute from one
client address and answers HTTP 429 after that. The same limit covers `join-pass`, the Turnstile
step every online join makes first (#560), so a flood can't spend Cloudflare verifications either. The guest page shows its usual "wait a moment"
message for that 429. Kiosks join through the same rule, so a shop with a kiosk and guests on its
own Wi-Fi shares one allowance, and so do guests behind one mobile carrier's NAT. 30 (the
review's figure, up from the ticket's 15) leaves room for that; flood protection is the same.

- [ ] **Self-hosted (Kong).** Add both services from `deploy/selfhost/kong-join-rate-limit.yml`
      to the gateway's `kong.yml`: `rest-v1-join` next to `rest-v1`, and
      `functions-v1-join-pass` next to `functions-v1`. Each `plugins` list must repeat its parent
      service's list exactly, plus `rate-limiting`. Add `rate-limiting` to `KONG_PLUGINS`, then
      restart Kong.
  - **Required when anything sits in front of Kong** (Caddy, nginx, a load balancer,
    Cloudflare): set `KONG_REAL_IP_HEADER` to the header that proxy overwrites with the client
    address, and `KONG_TRUSTED_IPS` to that proxy's addresses only. Without this, Kong sees every
    guest as the proxy, and one flood blocks every guest at every shop for a minute. The database's
    per-network limit makes the same mistake, because it reads the `X-Real-IP` that Kong
    forwards.
  - The rule counts per client address as Kong sees it, which is the address Kong forwards as
    `X-Real-IP` and `private.client_ip()` reads (`deployment_settings.client_ip_header`
    `x-real-ip`).
  - `policy: local` counts per Kong node. With more than one node, each allows 30.
  - PostgREST (port 3000) and the Edge Runtime (port 9000) must not be reachable except through
    Kong, or the rules can be skipped.
- [ ] **Supabase Cloud.** Supabase's own gateway has no per-path rule you can set, and
      `<ref>.supabase.co` stays reachable directly. So a rule you put in front of it (a Cloudflare
      rate-limiting rule on a proxied custom domain, matching `/rest/v1/rpc/join_queue` and `/functions/v1/join-pass`, 30
      requests per minute per IP) slows only naive floods. Anyone who calls the project URL
      directly skips it. On Cloud the database limits are the real bound.
  - **Before choosing `client_ip_header` on Cloud, look at the headers.** `*.supabase.co` is
    itself behind Cloudflare, so what `x-real-ip` and `cf-connecting-ip` hold, directly and
    through your own custom domain, has to be seen, not assumed. In the SQL editor, create
    `api.debug_headers()` as
    `select current_setting('request.headers', true)::json`, grant execute to `anon`, and POST
    to it four ways: directly, through the custom domain, and each again with made-up
    `X-Real-IP` / `CF-Connecting-IP` / `X-Forwarded-For`. Then drop it the same session. Pick
    the header that shows your real address every time and never the made-up one. If neither
    does, stop and ask in #76.
- [ ] **Prove it:** from a machine that isn't on the shop's network, run
      `API_URL=https://<api origin> APIKEY=<publishable key> node scripts/check-join-rate-limit.mjs`.
      It must print `ok` for:
  - for joins and for join passes, plain requests (429 after 30);
  - joins with spoofed `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` (429 at once);
  - every other spelling of the path (`//rpc`, trailing slash, percent-encoding, and so on).
  Then, within a minute, run it again with `--one` from a different network, such as a phone
  hotspot. It must print `ok second network` for joins and join passes: a 429 there means every
  client shares one limit (see the required step above). The script joins a queue that doesn't
  exist and sends a made-up Turnstile token, so it creates nothing.

## Auth CAPTCHA, rate limits and email (#76)

Sign-up, sign-in and sign-in links are open to anyone, so they get the same protection as joins:
a Turnstile check, rate limits, and a real mail sender. The code is merged. What is left needs
The maintainer's Cloudflare and mail accounts, so each step below says exactly what to supply.

### CAPTCHA on sign-in and sign-up

When Auth's CAPTCHA is on, it refuses sign-up, password sign-in, sign-in links, password recovery,
magic links and resending a confirmation unless the request carries a token Cloudflare accepts. The sign-in and
sign-up pages already send one when `VITE_AUTH_TURNSTILE_SITE_KEY` is set at build time (and show
the usual Turnstile checkmark). Emailed links and codes (`/verify`) and authenticator codes are
not behind it; the verify rate limit and 8-digit codes cover those (#509).

- [ ] **Supply:** a Turnstile widget in **managed** mode for the app's hostname, made in
      Cloudflare's dashboard. Use a separate widget from the join page's, so each secret lives in
      one place and can be rotated alone. You need its **site key** (public) and its **secret**.
- [ ] **Do it in this order, or nobody can sign in:**
  1. Set `VITE_AUTH_TURNSTILE_SITE_KEY=<site key>` in the web build and deploy the web app. With
     CAPTCHA still off at Auth, sign-in works as before: Auth ignores the token.
  2. Turn CAPTCHA on at Auth. Hosted: Authentication → Attack Protection → enable CAPTCHA, provider
     Cloudflare Turnstile, paste the secret. Self-hosted: give GoTrue
     `GOTRUE_SECURITY_CAPTCHA_ENABLED=true`, `GOTRUE_SECURITY_CAPTCHA_PROVIDER=turnstile` and
     `GOTRUE_SECURITY_CAPTCHA_SECRET=<secret>` from your secret store. Never put the secret in
     git or in `apps/web`. Prefer the dashboard (or your own GoTrue environment) to
     `supabase config push`: a push applies every Auth setting in `supabase/config.toml` to the
     project, including ones you have changed there by hand.
  3. Auth itself calls `challenges.cloudflare.com` to check each token, so its host needs outbound
     HTTPS to it. If it can't, every sign-in fails with HTTP 500.
- [ ] **Prove it:** run
      `AUTH_URL=https://<ref>.supabase.co/auth/v1 APIKEY=<publishable key> node scripts/check-auth-captcha.mjs`.
      It must print twelve `ok` lines: six requests with no token and six with a made-up token are
      all refused with `captcha_failed`. The requests name addresses with no account, so nothing is
      created or sent. A `FAIL ... not refused` means CAPTCHA is off; a `FAIL ... HTTP 500` means
      Auth can't reach Cloudflare. Then sign in once, and sign up with a new address, in a real
      browser.
- Browsers that block `challenges.cloudflare.com` (some content blockers) leave the sign-in button
  disabled, because there is no token. The CSP already allows that host (`apps/web/public/_headers`,
  `deploy/selfhost/Caddyfile`).
- Local dev and e2e keep CAPTCHA off, so they need no Cloudflare keys.

### Auth rate limits

`supabase/config.toml` holds the values we want. The local stack never enforces the per-IP ones
(see the OTP item above); on production, set them by hand where Auth reads them (hosted:
Authentication → Rate Limits; self-hosted: `GOTRUE_RATE_LIMIT_*`, which also need
`GOTRUE_RATE_LIMIT_HEADER`).

| Limit | Value | Why |
| --- | --- | --- |
| Emails sent per hour | 300 on production (30 in `config.toml`) | Needs custom SMTP. Every sign-up, code, reset and invite shares this one cap, so 30 locks everyone out in a launch burst. Check the email provider's plan covers it. |
| Sign-ups and sign-ins per 5 min per IP | 30 | A shop's devices share one address; CAPTCHA stops bots before this matters. |
| Verifications per 5 min per IP | 30 | Wrong-code guessing (#509). |
| Token refreshes per 5 min per IP | 150 | Many tablets behind one address. |
| Anonymous sign-ins | off | Not used. |

### Custom SMTP

Hosted Supabase's built-in email is capped at a few messages an hour and is for trying things out.
Real sign-up and sign-in emails need a sender we control. This part cannot be done without the maintainer.

- [ ] **Supply:**
  - a domain you control for the sender, with access to its DNS (for example `mail.<your domain>`);
  - an account at a transactional email provider (one with a free tier is enough for the pilot).
    The default is [Resend](https://resend.com); any provider with SMTP works, and only the values
    below change (Brevo, Postmark, Amazon SES, Mailgun);
  - from that account: the SMTP **host**, **port** (587 or 465), **username** and **password or API
    key**. Resend: host `smtp.resend.com`, port `465` (implicit TLS) or `587` (STARTTLS), username
    `resend`, password a send-only API key. Check the provider's current free-tier limits;
  - the **sender address** and **name** (for example `no-reply@mail.<your domain>`, "Queue").
- [ ] **DNS:** add the records the provider shows for that domain, normally SPF (TXT), DKIM (CNAME or
      TXT) and its verification record, plus a DMARC TXT (`v=DMARC1; p=none; rua=mailto:<you>`), and
      wait until the provider says the domain is verified.
- [ ] **Turn it on.** Hosted: Authentication → Emails → SMTP Settings, enable custom SMTP and fill in
      the fields above. Self-hosted: `GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`,
      `GOTRUE_SMTP_PASS`, `GOTRUE_SMTP_ADMIN_EMAIL`, `GOTRUE_SMTP_SENDER_NAME`. Then set the emails
      per hour limit to 30 (table above).
- [ ] **Check:** sign up with a real inbox. The email must arrive in the inbox, not spam, and show
      the 8-digit code (the "Auth emails carry the 8-digit code" item above). In the message headers,
      SPF, DKIM and DMARC should all say pass.
