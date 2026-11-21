# Custom domains

A business can serve its join page on its own hostname (`queue.shop.com`). The database decides
whether a name is verified; the web app and the TLS layer only ask.

## Records the owner adds

On `/admin/domains` the owner claims a hostname and adds two DNS records:

| Record | Value |
| --- | --- |
| `TXT _queue-verify.<host>` | the token shown on the page (proves ownership) |
| `CNAME <host>` | `VITE_DOMAIN_CNAME` if the deployment sets it, otherwise the host of `PUBLIC_URL` |

`domain-check` re-reads the TXT record when the owner presses "Check now" and once a day. Three
failed daily checks in a row disable a verified domain.

## Who issues the certificate

- **Self-host:** Caddy's on-demand TLS asks `GET http://functions:9000/domain-check?domain=<name>`
  (on the compose network, not through Kong) at the first visit of a new name, and requests a
  certificate only when the answer is 200, which only a verified hostname of an active org gets.
  An unverified name fails the TLS handshake and Caddy contacts no certificate authority. The
  `https://` catch-all site in `deploy/selfhost/Caddyfile` then serves the static app for that
  host; staff and admin pages redirect to the main host, and the API stays on the main host.
  Ports 80 and 443 must reach Caddy for every custom name (a tunnel that ends TLS elsewhere needs
  its own certificate setup for those names). The public `/functions/v1/domain-check` Kong route
  (120 requests a minute per address) lets the SPA ask the same question.
- **A hosted deployment** may need to prepare the name first, for example add it to its hosting
  provider. It does that in its own copy of `supabase/functions/domain-check/extensions.ts`.

## Extension point: `supabase/functions/domain-check/extensions.ts`

Two no-op functions. A deployment replaces the file; never change a name or shape here without an
issue that agrees to it (AGENTS.md).

| Export | Called | Notes |
| --- | --- | --- |
| `onDomainStatusChange(change)` | once after a check really changes a domain's status | `from`, `to`, `hostname`, `domainId`, `orgId`, all read from the database. Not called for a check that leaves the status as it was. |
| `onRecheckComplete(verifiedHostnames)` | at the end of every daily re-check | The hostnames verified at that moment. Use it to heal a missed change and to remove a domain an owner deleted (a removal is an RPC, so it has no status change). |

A hook that throws is logged and ignored: it never changes the check's answer, the domain's
status or its failure count.

## Limits and what to expect

- **Anyone can start a TLS handshake with any server name**, and each unknown name makes Caddy ask
  `domain-check` once. The function refuses names the database could never hold (no dot, IP literal,
  label over 63 characters, bad characters) before it queries anything, and remembers an unknown
  name for a minute where the runtime keeps the function warm. Self-host's function runtime may start
  a fresh worker per request, in which case only the first check applies. The `ask` call also
  bypasses Kong's rate limit (it goes straight to the function). If you expect hostile traffic, limit
  new connections per source address at your firewall or load balancer.
- **A verified name takes up to a minute to start answering** after a negative lookup (the cache
  above); pressing "Check now" in the same function instance clears it at once.
- **A disabled or removed domain keeps its certificate until Caddy stops using it.** The static app
  it serves shows no tenant data (the page asks `domain-check`, which now answers 404, and falls
  back to the main host's pages). We did not verify whether Caddy asks again before renewing, so
  plan on a disabled name's certificate staying valid until it expires.
- **No wildcard certificates.** Each name gets its own.

## What a custom host can and cannot reach (checked for #1438)

The custom host is an alias for the guest pages. It runs the same web build as the main host, so
this is what was checked, and where each answer lives.

| Question | Answer |
| --- | --- |
| Staff, admin, devices, sign-in | `lib/host.ts`: any path outside `/q /v /a /b /o /w /u` redirects to `PUBLIC_URL`. e2e: `/staff` and `/admin`. |
| Is the main host's session readable there? | No. The session is in `localStorage`, which is per origin; a guest page stores none (I-7). e2e: no `sb-*-auth-token` key after joining on a custom host. |
| Can a Host header pick another tenant's location? | No. The slug comes only from `domain-check` for a verified host (the database), never from the request. Any `/q/<slug>` opens on any host, as on the main host: join pages are public. |
| CORS | Status, appointment and widget calls are API calls that answer any origin (Supabase, and the self-host Kong `cors` plugin). `join-pass` and `unsubscribe` answer any origin and carry no cookies. `public-join` and `payment-intent` answer verified custom hosts only, through one shared rule (`_shared/custom-origin.ts`: https, no port, checked in the database, cached 60 s, lookups rate limited per network). |
| Framing | The same `vercel.json` headers apply on every host: `frame-ancestors 'none'` everywhere except `/w/`, which any site may embed. |
| Service worker | Registered per origin at `/sw.js`; a custom host gets its own worker and push subscription. `sw.js` is `no-cache`, so updates reach it as on the main host. |
| Auth redirects | Sign-in builds its link from the current origin, but `/auth` is not a guest path: a custom host redirects to `PUBLIC_URL` before the page loads, so no sign-in link ever carries a custom host. |
| CAPTCHA | `pow` (hosted today) has no hostname binding. **Turnstile does:** each custom host would have to be on the widget's hostname list, and Cloudflare has no wildcard for other people's domains, so a deployment that turns Turnstile on cannot serve custom hosts without a per-host call. Keep `VITE_PUBLIC_JOIN=pow` there. |
