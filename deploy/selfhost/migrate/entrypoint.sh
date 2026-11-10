#!/bin/sh
# One-shot: refuse bad secrets, apply pending migrations, configure the database's Vault secrets,
# publish the Edge Functions, exit 0. Everything here is idempotent, so `docker compose up -d` can
# run it on every start. Exits non-zero (and the app services never start) if any step fails.
set -eu
cd /app

echo "migrate: checking secrets"
sh ./check-secrets.sh

# The password travels in PGPASSWORD, not in a URL, so it is in no process list or error line.
export PGPASSWORD=$POSTGRES_PASSWORD
db_url="postgresql://postgres@db:5432/postgres?sslmode=disable"
psql_q() { psql "$db_url" -v ON_ERROR_STOP=1 -qtA "$@"; }

# A demo install gets a generated password; refuse to seed users nobody can sign in as, or with a
# weak one, before anything changes.
if [ "${DEMO_MODE:-false}" = true ]; then
  [ "${#DEMO_PASSWORD}" -ge 12 ] || { echo "migrate: DEMO_MODE=true needs DEMO_PASSWORD of 12+ characters (setup.sh --demo generates one)" >&2; exit 1; }
  case $DEMO_PASSWORD in *[!A-Za-z0-9._~-]*) echo "migrate: DEMO_PASSWORD may only use letters, digits and . _ ~ -" >&2; exit 1 ;; esac
fi

echo "migrate: waiting for the database"
i=0
until pg_isready -q -d "$db_url"; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "migrate: database not ready after 60 s" >&2; exit 1; }
  sleep 1
done

# Realtime creates realtime.messages after it is healthy; the migrations add policies to it.
i=0
until [ "$(psql_q -c "select to_regclass('realtime.messages') is not null")" = t ]; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "migrate: realtime.messages missing after 60 s" >&2; exit 1; }
  sleep 1
done

echo "migrate: applying migrations"
# --include-all also applies a migration older than the newest one recorded, so a release that
# slots a migration in order cannot be skipped. Applied versions are tracked in
# supabase_migrations.schema_migrations; with nothing pending this changes nothing.
supabase db push --db-url "$db_url" --include-all --yes

# Demo data is only ever added: a clean install (DEMO_MODE unset) has zero organizations and
# starts in onboarding. Turning DEMO_MODE off later leaves the demo organization in place.
if [ "${DEMO_MODE:-false}" = true ]; then
  if [ "$(psql_q -c "select exists (select 1 from app.organizations where id = '00000000-0000-4000-8000-00000000d001')")" = t ]; then
    echo "migrate: demo organization already present"
  else
    echo "migrate: seeding the demo organization"
    # The shared seed reads its password from this setting.
    PGOPTIONS="-c qm.demo_password=$DEMO_PASSWORD" psql_q -o /dev/null -f demo-seed.sql
  fi
fi

# The staff "Contact support" form emails app.platform_flags.support_inbox, which a migration
# defaults to the hosted service's inbox. This install's own address replaces it; with none set the
# web app hides the form (apps/web/src/lib/config.ts), so nothing is ever sent to that default.
if [ -n "${SUPPORT_EMAIL:-}" ]; then
  echo "migrate: setting the support inbox"
  psql_q -o /dev/null <<'SQL'
\set inbox `printenv SUPPORT_EMAIL`
update app.platform_flags set support_inbox = :'inbox';
SQL
fi

echo "migrate: configuring the dispatcher"
# The database tells the dispatch function to run through these two Vault secrets
# (supabase/seeds/01_local_dispatcher.sql does the same for the local stack).
# The secret reaches psql through the environment (`printenv`), not argv or the SQL text.
psql_q -o /dev/null <<'SQL'
\set url `echo http://kong:8000/functions/v1/dispatch-notifications`
\set key `printenv DISPATCH_SECRET`
select vault.update_secret(id, :'url') from vault.secrets where name = 'dispatcher_url';
select vault.create_secret(:'url', 'dispatcher_url')
  where not exists (select 1 from vault.secrets where name = 'dispatcher_url');
select vault.update_secret(id, :'key') from vault.secrets where name = 'dispatcher_key';
select vault.create_secret(:'key', 'dispatcher_key')
  where not exists (select 1 from vault.secrets where name = 'dispatcher_key');
notify pgrst, 'reload schema';
SQL

echo "migrate: publishing functions"
# A fresh copy each time, so a function deleted in a release disappears. The functions import
# @qm/domain by a path relative to the repository; in the volume it sits beside them.
find /functions -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R supabase/functions/. /functions/
mkdir -p /functions/packages
cp -R packages/domain /functions/packages/
cp -R deploy/selfhost/functions-main /functions/main
find /functions -name '*.test.ts' -delete
for config in /functions/*/deno.json; do
  sed -i 's#\.\./\.\./\.\./packages/#../packages/#' "$config"
done

echo "migrate: done"
