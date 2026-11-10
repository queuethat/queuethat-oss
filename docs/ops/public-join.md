# public-join: the anonymous way to join

`public-join` (Edge Function, `verify_jwt = false`) is where guests' joins go once the join page
uses it (2A-JN3) and anon's EXECUTE on `api.join_queue` is revoked (2A-JN4). It checks a CAPTCHA,
limits each network, then calls `api.join_queue` with the service role. Every database rule still
applies (accepting predicate, capacity, caps, on-site code) and its error codes come back as they are.

```
GET  /functions/v1/public-join/challenge     proof-of-work only: { challenge, difficulty, expiresAt }
POST /functions/v1/public-join               { queueId, serviceId?, name, phone?, email?, partySize?,
                                               locale?, idempotencyKey, deviceKey?, answers?, groupKey?,
                                               onsiteCode?, geo?: {lat,lng,accuracyM}, captcha }
```

Answers: `200 { token, display_ticket, status }`; `400 invalid_input | captcha_failed`;
`403 onsite_code_required | onsite_code_invalid | onsite_required | org_suspended | forbidden`; `404 not_found`;
`409 queue_not_accepting | capacity_reached | too_many_active_visits`; `429 rate_limited` with
`Retry-After`; `500 unknown`. Bodies over 4 KB (counted as they stream in), unknown fields and other origins are refused.

## Turning the join page over to it

Build the web app with `VITE_PUBLIC_JOIN=pow` (or `turnstile`, or `dev` for local work). The join page then
POSTs to this function instead of calling `api.join_queue`. With `pow` the page fetches a challenge and
solves it in a Web Worker while the guest types (about 1-2 s at the default difficulty; progress is read out
politely, nothing is interactive). With `turnstile` the widget uses the deployment's site key
(`private.deployment_settings.turnstile_site_key`) and its token is sent as `captcha`. A `429` shows
"Too many tries from this network. Try again in N minutes." counted down in an `aria-live="polite"` region.
Unset keeps the direct RPC path (and the `join-pass` flow) until 2A-JN4. The CSP still allows
`challenges.cloudflare.com` for every build; narrowing it per build flag is left to the deploy work.

## Environment

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | The join page's origin. The only origin CORS allows. |
| `CAPTCHA_PROVIDER` | `turnstile`, `pow` or `dev`. `dev` accepts everything and starts only when `ENVIRONMENT` is `local`, `development`, `dev` or `test` (unset or `production` is refused). |
| `TURNSTILE_SECRET_KEY` | Turnstile only. siteverify has a 3 s timeout and fails closed. |
| `POW_SECRET` | Proof of work only: HMAC key for challenges (use 32 random bytes). `POW_DIFFICULTY` sets the leading zero bits (default 16, about 1-2 s on a phone). |
| `PUBLIC_JOIN_IP_LIMIT`, `PUBLIC_JOIN_IP_WINDOW_SECONDS` | Joins per network, default 10 per 600 s. |
| `CLIENT_IP_HEADER` | `x-real-ip` (default) or `cf-connecting-ip`. The one header your proxy sets with the real client address; keep it equal to `deployment_settings.client_ip_header`. Other headers (including `x-forwarded-for`) are ignored because clients can write them. A missing or malformed value counts as one shared "unknown" network, except on `/phone-code`, which is refused (403, logged) because one shared bucket would let one caller exhaust everyone's allowance. IPv6 clients are limited per /64 there, as in the database. |
| `PUBLIC_JOIN_IP_SALT` | Optional. Salt for IP hashes; defaults to the service role key. |

Per-queue limits (`per_network_joins`, `join_rate_per_min`, the hourly ceiling) stay in the database.

## Limits and privacy

- IPs are hashed (sha256 of ip, the UTC date and a secret) before they touch `private.rate_buckets`,
  so a hash is not reversible and does not link a person across days. Raw IPs are never stored or logged.
- The guest's address reaches the database only as `x-qm-client-ip`, which `private.client_ip()` believes
  for the service role alone (Kong overwrites `x-real-ip` with the function's own address).
- A wrong on-site code is counted here (5 per 600 s per network) because the database rolls the whole
  join back, including its own counters. Without this function the 4-digit code is only a deterrent.
- A solved proof-of-work challenge is spent once across instances, in the same table. A challenge that
  straddles UTC midnight can in theory be spent twice within its two-minute life.
- `api.hit_rate_limit` is in `api` (not `ops`) because PostgREST exposes only `api`; it is executable by
  the service role only. `ops.purge_rate_buckets` clears buckets older than a day (pg_cron, 03:23 UTC).
- This function replaces the `join-pass` flow ([turnstile.md](turnstile.md)) once the page switches.
  The database accepts a service-role join without a pass; everyone else still needs one while a site key is set.

## Testing

`supabase/functions/public-join/handler.test.ts` (Deno, `pnpm test:functions`) covers the limits, CAPTCHA
failure, error mapping, CORS and body checks. `supabase/tests/abuse/rate_buckets.test.sql` covers the
database side.

## Closing the direct path (2A-JN4, #114)

Until it is closed, a script can skip the function and call `api.join_queue` as `anon` with the
public key, and then the CAPTCHA and the per-IP limits above are advisory. The switch is one
setting, not a migration:

```sql
update private.deployment_settings set anon_join_enabled = false;  -- close
update private.deployment_settings set anon_join_enabled = true;   -- roll back
```

With it off, `api.join_queue` refuses every caller except paired kiosks and the service role (which is
what the function uses) with `captcha_required` (DETAIL `public_join`). Signed-in non-kiosk accounts are
refused too: sign-up is open, so a throwaway account would otherwise skip the function.
Staff add guests with `staff_add_visit`, which is unaffected.

Close it only when all of these hold:

1. The deployment sets `VITE_PUBLIC_JOIN` (`pow` or `turnstile`) for the web build, and the
   `public-join` function is deployed with its secrets, as above. Without that, the guest page
   still calls the RPC and every guest join fails with the "robot check" message.
2. Guest bundles from before that deploy have aged out: the service worker caches guest pages, so
   wait at least 7 days after the deploy.
3. The maintainer has confirmed.

Why a setting and not `REVOKE EXECUTE ... FROM anon` (the ticket's wording): the revoke cannot be
undone without another migration (migrations here are forward-only and sort last), it breaks the
local and CI setups that have no edge runtime (every e2e spec and most pgTAP files join as `anon`),
and the guest functions list stays the five of I-4. If you still want the grant gone once the
switch has been off in production for a while, a later migration can revoke it and move the
tests to the service role.

## Geofenced queues (2B-Q10)

A queue with `join_restriction = 'geofence'` refuses online joins (`403 onsite_required`) unless `geo`
is within the location's `geofence_m` of its `lat`/`lng`. The browser reports the position, so this is
a soft check a determined guest can fake; for a real control use the on-site code (`join_restriction =
'onsite_code'`). The function forwards `geo` as the `x-qm-geo` header, which the database believes only
from the service role, so a direct `api.join_queue` call by anon can never join a geofenced queue.
Wrong positions count against the same per-IP lockout as wrong on-site codes.
