# QueueThat self-host

Run the whole product on one box with Docker: a pinned Supabase stack, the web app and Caddy. No
telemetry leaves it.

## Requirements

- Linux with Docker Engine 25+ and the Compose plugin; 2 vCPU, 4 GB RAM, 20 GB disk.
- A DNS name pointing at the box and ports 80 and 443 open, or a Cloudflare tunnel (`tunnel` profile).
- An SMTP account for staff invites, sign-in links and guest email (not needed for demo mode or
  for the first owner account, see below).

## Install

```sh
cd deploy/selfhost
./setup.sh        # asks for the public URL, SMTP and sign-up mode; writes .env
docker compose up -d --wait
```

### Create the first account

A clean install has no users, and by default nobody can sign up: `setup.sh` defaults to
invite-only, and even with `--signup open` a new account must confirm its email, which needs SMTP.
Create the first owner from the server instead, with the service-role key that `setup.sh` wrote to
`.env`:

```sh
cd deploy/selfhost
set -a; . ./.env; set +a
curl -X POST "$PUBLIC_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"choose-a-long-password","email_confirm":true}'
```

Open your public URL, sign in with that email and password, and the onboarding wizard creates
your business, first location and first queue. Invite everyone else from **Admin > Team**; invites
are emails, so they need SMTP. The service-role key bypasses every access rule: use it only on the
server and never put it in a browser.

To look around without any of this, use [demo mode](#demo-mode).

### Your own terms, privacy notice and support inbox

The app has no legal pages or support inbox built in. Until you set these in `.env`, the links
and the staff "Contact support" form are simply not shown.

| Variable        | Where it appears                                                                              |
| --------------- | --------------------------------------------------------------------------------------------- |
| `TERMS_URL`     | Beside the text-message opt-in on the join page, on the sign-up form, and at `/terms`         |
| `PRIVACY_URL`   | The same places, the "how long we keep your details" sentence, and at `/privacy`              |
| `SUPPORT_EMAIL` | The staff "Contact support" form sends its email here (it needs SMTP to deliver)              |

Apply a change with `docker compose up -d`. `./setup.sh --rotate` keeps all three. If you send
text messages, carriers expect the opt-in to link to your terms and privacy notice, so set both
before turning SMS on.

### Turning on SMS, WhatsApp or payments

Free channels (web push, email, Telegram) work as soon as they are configured. Channels that cost
money or carry legal duties stay locked until you, the operator, say the install is ready. The
database refuses to switch one on (`channel_prerequisite_missing`) until this has been run once
as the database owner:

```sh
cd deploy/selfhost
docker compose exec db psql -U supabase_admin -d postgres \
  -c "update app.platform_flags set compliance_gate_passed_at = now();"
```

Run it only after the compliance checks pass for the version you deploy
([phase3-gate.md](../compliance/phase3-gate.md)) and you have read
[the SMS registration guide](../ops/10dlc-runbook.md) if you will text US numbers. An owner then
enables each channel under **Admin > Integrations** once its own prerequisites hold; a refused
attempt lists what is missing. Setting the column back to `null` closes every paid channel at
once.

### Limits

Out of the box a business can have any number of locations and staff, and its paid messages
(SMS, WhatsApp) are capped per day and per month. These limits are rows in the table
`app.entitlement_defaults` and apply to every business on the install. There is no screen for
them; you change them with SQL as the database owner.

| Key | Shipped value | What it limits |
| --- | --- | --- |
| `limit.locations` | `-1` | Locations per business. `-1` means no limit. |
| `limit.members` | `-1` | Staff accounts per business, owner included. `-1` means no limit. |
| `paid_channels` | `true` | Whether a business may switch on SMS and WhatsApp. |
| `messaging.daily_cap` | `200` | Most SMS (and, separately, WhatsApp) messages a business sends per UTC day. |
| `messaging.new_org_daily_cap` | `25` | The same cap for a business younger than `messaging.new_org_days`. |
| `messaging.new_org_days` | `14` | How many days a business counts as new. |
| `messaging.monthly_budget_micros` | `20000000` | Most a business spends on SMS (and, separately, WhatsApp) per UTC month, in millionths of a currency unit (20000000 is 20.00). |

A business can set a lower daily cap or budget for itself, never a higher one. When a location or staff limit is reached, adding one more is refused with
`plan_limit_reached`; nothing that already exists is removed.

To change a limit for every business:

```sh
cd deploy/selfhost
docker compose exec db psql -U supabase_admin -d postgres \
  -c "update app.entitlement_defaults set value = '500' where key = 'messaging.daily_cap';"
```

To give one business a different value, add a row to `app.org_entitlements`. It wins over the
default for that business only. `reason` is a note for yourself and cannot be blank:

```sh
docker compose exec db psql -U supabase_admin -d postgres -c "
  insert into app.org_entitlements (org_id, key, value, reason)
  values ((select id from app.organizations where name = 'Demo Barber'), 'messaging.daily_cap', '1000', 'busy shop')
  on conflict (org_id, key) do update set value = excluded.value, reason = excluded.reason;"
```

Delete the row to put the business back on the default. Values are JSON: numbers and `true` or
`false`, in single quotes as above. Changes apply at once; nothing needs a restart.

### What the server needs to reach

The `web` and `migrate` images are built on the server from this repository, so the first
`docker compose up` needs outbound HTTPS to Docker Hub, GHCR, the npm registry and the Debian and
Alpine package mirrors. The Edge Functions also fetch their npm dependencies when they first
start. Guest notifications, device pairing and the health endpoint run in those functions, so a
server with no outbound access will start but will not pair a display or send a message.

`setup.sh` needs only bash and openssl. It generates every secret (database password, JWT secret,
the anon and service-role keys signed with it, the Vault and Realtime keys, a web-push key pair) and
writes `.env` with mode 600. It refuses to run if `.env` exists. For CI or scripts:
`./setup.sh --non-interactive --public-url https://queue.example.com --signup invite`.

### Known demo keys

Supabase publishes an example JWT secret and example anon and service keys. Anyone can sign a
token with them. `check-secrets.sh` runs before the migrate service and the web container start and
stops the stack when a secret is a published value (by sha256, or by `iss: supabase-demo`), is empty
or short, or a key is not signed with `JWT_SECRET`. It prints the variable's name, never its value.

### Rotating secrets

`./setup.sh --rotate` replaces every secret and keeps the old file as `.env.bak-<time>` (also mode
600; delete it once the new stack works). What breaks: everyone is signed out, paired displays and
kiosks must be paired again, and push subscriptions stop until guests re-subscribe. The database
password is kept, because Postgres reads it only when the data volume is created.

## What runs

| Service                                    | Role                                         | Published              |
| ------------------------------------------ | -------------------------------------------- | ---------------------- |
| web                                        | Caddy: static app and the API paths (#210)   | 80, 443                |
| kong                                       | API gateway: key check, join rate limit      | no                     |
| db, auth, rest, realtime, storage, imgproxy | Supabase, pinned by tag and digest           | no                     |
| functions                                  | Edge Runtime serving `supabase/functions`    | no                     |

Nothing but `web` is reachable from outside. Studio, the Postgres meta API, Kong and port 5432 are
never published (technical-design.md 5).

## Profiles

Add with `docker compose --profile <name> up -d`.

| Profile  | Adds                                                                       |
| -------- | -------------------------------------------------------------------------- |
| `studio` | Supabase Studio on `127.0.0.1:54323` only; use `ssh -L 54323:localhost:54323` |
| `tunnel` | cloudflared with `TUNNEL_TOKEN`; ingress only to `web`                     |
| `backup` | nightly encrypted backups, see [backups.md](backups.md)                    |

The `analytics` profile (Logflare, Vector) is not shipped: it adds three containers and about 1 GB
for logs nobody reads on a one-shop box. Use `docker compose logs` or ship container logs yourself.

## Demo mode

A clean install has zero organizations: the first sign-in leads to onboarding. To try the product
with sample data instead, run `./setup.sh --demo`. It sets `DEMO_MODE=true` and generates
`DEMO_PASSWORD`; `migrate` then seeds the Demo Barber organization once (guest page `/q/demo-barber`,
sign in as `owner@demo.test` or `staff@demo.test`), and every page shows a "Demo mode" banner. No
password is ever `password123`. There is no nightly reset: visits are never deleted, so the honest reset is
`docker compose down -v` and a fresh start. Turning `DEMO_MODE` off later hides the banner but keeps
the demo organization; don't use demo mode for a real shop.

## One hostname, routed by Caddy

Caddy serves the app and proxies `/rest/v1`, `/auth/v1`, `/realtime/v1` (websocket),
`/functions/v1` and `/storage/v1` to the gateway. `/studio`, `/pg` and `/project` answer 404. Caddy
sets the visitor's address in `X-Forwarded-For` itself, replacing whatever the visitor sent, so the
join rate limit (30 a minute per address) can't be dodged by spoofing a header.

If Docker NATs every connection to one address (some rootless setups), all guests look like one
client and share that limit; use the default rootful Docker, or put the box behind the tunnel.

### Tunnel (no public IP)

1. In Cloudflare Zero Trust create a tunnel and a public hostname pointing at `http://web:80`
   (that is all [`cloudflared/config.yml`](../../deploy/selfhost/cloudflared/config.yml) says).
2. In `.env`: `TUNNEL_TOKEN=...`, `PUBLIC_URL=https://your-hostname`, `SITE_ADDRESS=:80` (Cloudflare
   ends TLS) and `QM_TRUSTED_PROXIES=private_ranges` (so the visitor's `CF-Connecting-IP` is used) and `WEB_BIND=127.0.0.1` (so nothing but the tunnel can reach Caddy; otherwise a guest could forge the header and dodge the join rate limit).
3. `docker compose --profile tunnel up -d`.

## Upgrades

Images are pinned in `docker-compose.yml`; Dependabot bumps them weekly and the nightly
`selfhost-smoke` job boots each bump before it lands. To upgrade, pull the latest `main` (there are no tagged releases yet), then
`docker compose pull && docker compose up -d`. Migrations are expand/contract, so the migrate
service (#209) can run before the new web image starts.

The scheduled jobs (pg_cron) keep running while migrations are applied. If a job and a migration
ever lock the same tables in opposite order, Postgres cancels one of them; the migrate service
applies the migrations again, up to three times, and the job runs again at its next tick. If
`migrate` still exits with `deadlock detected`, run `docker compose up -d` once more: migrations
that were applied are not applied twice.

## Checks

`bash deploy/selfhost/tests/check-compose.sh` fails when an image has no digest or a port other than
80 or 443 is published.
