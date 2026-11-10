# Turnstile on online joins

Off by default, so self-hosted installs without Cloudflare join exactly as before. When it is on,
every join from `/q/:slug` needs a Cloudflare Turnstile check. Kiosk joins and staff adds never do.

## How it works

1. `api.get_location_public` returns the deployment's `captcha_site_key`, and the join page shows
   the widget in managed mode. Most guests see a checkmark and never solve anything.
2. On Join, the page sends the widget's token to the `join-pass` Edge Function. That function checks
   the token with Cloudflare's siteverify (3 s timeout, fails closed). Only then does it ask the
   database for a pass (`api.issue_join_pass`, service role only).
3. The page calls `api.join_queue` with `p_join_pass`. The database spends the pass in the join's
   own transaction, so calling the RPC directly can't skip the check. A pass buys one join and
   expires after 5 minutes. A replay of the same join (same queue and idempotency key) may present it
   again for a day, and a join the database refuses leaves it unspent.

## Turning it on

1. In Cloudflare, create a Turnstile widget in **managed** mode for the app's hostnames.
2. Give the Edge Function the secret: `supabase secrets set TURNSTILE_SECRET_KEY=...`, and deploy
   `join-pass`.
3. Set the site key and the hostnames the join page is served on (the host of `VITE_PUBLIC_URL`,
   plus any other domain guests use), lowercase, with no scheme or port:
   `update private.deployment_settings set turnstile_site_key = '<site key>', turnstile_hostnames = '{queue.example.com}';`

Do step 2 before step 3. With a site key set and no secret, the function can't verify anything,
and every online join fails closed with "We couldn't confirm you're not a robot". The same
happens with an empty `turnstile_hostnames`: a site key is public, so another site could embed
it, and join-pass issues a pass only for a token solved on a listed hostname (siteverify reports
it).
To turn it off, set `turnstile_site_key` back to null.

The CSP (`apps/web/public/_headers`, `deploy/selfhost/Caddyfile`) allows `challenges.cloudflare.com`
for scripts and frames. The script loads only on a join page whose deployment has a site key.

## Testing

Cloudflare's test keys need no account. The site key `1x00000000000000000000AA` always passes. The
secret `1x0000000000000000000000000000000AA` accepts any token, and
`2x0000000000000000000000000000000AA` rejects every token. The passing one reports the hostname
`example.com`, so list that while testing with them, and remove it before going live. `tests/e2e/join-captcha.spec.ts` uses
them; `supabase/tests/rpc/join_pass.test.sql` covers the database side.

## Not covered yet

- The proof-of-work verifier for installs that won't depend on Cloudflare (backlog 2A-JN1).
- An edge rate rule for `/functions/v1/join-pass` (in #556, which owns the Kong config).
- Sending `remoteip` to siteverify, and checking `action`.
