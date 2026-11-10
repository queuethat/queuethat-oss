#!/usr/bin/env bash
# O7 (#78): restores a backup made by scripts/backup.sh into the local Supabase stack and checks
# that it works. Wipes the local database, so never point it at anything else. Run weekly by
# .github/workflows/restore-drill.yml; docs/ops/backups.md explains each check.
#
# Decrypted SQL only ever flows through pipes into psql; the encrypted files are the only
# backup data written to disk, in a temp dir removed on exit.
#
# Required:
#   BACKUP_AGE_IDENTITY       the age secret key (AGE-SECRET-KEY-1...), or
#   BACKUP_AGE_IDENTITY_FILE  a file holding it.
# Where the backups are (as for backup.sh):
#   BACKUP_S3_BUCKET + BACKUP_S3_ENDPOINT (+ AWS_* credentials) and BACKUP_S3_PREFIX, or BACKUP_DIR.
# Optional:
#   BACKUP_STAMP  which backup, e.g. 2026-10-29T031500Z. Default: the newest.
#   DRILL_E2E     1 runs the Playwright smoke spec too (needs the demo accounts, so local
#                 seeded backups only); 0 skips it. Default: run it when the demo owner exists.
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."
command -v age >/dev/null || {
  echo "age is not installed (Debian/Ubuntu: apt install age; macOS: brew install age)" >&2
  exit 2
}

prefix="${BACKUP_S3_PREFIX:-db/}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

key="$work/identity"
if [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
  printf '%s\n' "$BACKUP_AGE_IDENTITY" >"$key"
else
  cp "${BACKUP_AGE_IDENTITY_FILE:?set BACKUP_AGE_IDENTITY or BACKUP_AGE_IDENTITY_FILE}" "$key"
fi

echo "--- fetching the backup"
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  : "${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT}"
  s3() { aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 "$@"; }
  stamp="${BACKUP_STAMP:-$(s3 ls "s3://$BACKUP_S3_BUCKET/$prefix" | awk '$1 == "PRE" { print $2 }' | sort | tail -n 1)}"
  stamp="${stamp%/}"
  s3 cp --recursive --only-show-errors "s3://$BACKUP_S3_BUCKET/$prefix$stamp/" "$work/set/"
else
  stamp="${BACKUP_STAMP:-$(find "${BACKUP_DIR:?set BACKUP_S3_BUCKET or BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??????Z' -printf '%f\n' | sort | tail -n 1)}"
  cp -r "$BACKUP_DIR/$stamp" "$work/set"
fi
[ -n "$stamp" ] && [ -f "$work/set/data.sql.age" ] || {
  echo "no backup found" >&2
  exit 1
}
echo "backup $stamp"
unseal() { age -d -i "$key" "$work/set/$1.age"; }

eval "$(pnpm exec supabase status -o env 2>/dev/null | grep -E '^(DB_URL|API_URL|ANON_KEY|JWT_SECRET)=')"
# The local superuser: roles.sql grants on parameters, which the postgres role may not.
admin_url="${DB_URL/postgres:postgres@/supabase_admin:postgres@}"
db() { psql "$admin_url" -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "--- emptying the local database (no migrations, no seed)"
pnpm exec supabase db reset --no-seed --last "$(find supabase/migrations -name '*.sql' | wc -l)"

echo "--- restoring roles, schema and data in one transaction"
# Replica mode skips triggers and foreign-key checks while rows load, as Supabase's restore
# guide does: the rows are already consistent, and audit triggers must not fire twice.
{
  unseal roles.sql
  unseal schema.sql
  echo 'SET session_replication_role = replica;'
  unseal data.sql
} | db --single-transaction -o /dev/null

echo "--- restoring migration history, Vault secrets and cron jobs"
{
  echo 'create schema if not exists supabase_migrations;'
  echo 'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);'
  unseal migrations.sql
  unseal vault.sql
  unseal cron.sql
  # A drill must not reach production: no dispatcher to call, and no job runs.
  echo "delete from vault.secrets where name like 'dispatcher%';"
  echo 'select cron.alter_job(jobid, active => false) from cron.job;'
} | db --single-transaction -o /dev/null
db -c "notify pgrst, 'reload schema'"

echo "--- smoke: row counts match the backup"
unseal counts.tsv | while IFS=$'\t' read -r table expected; do
  actual="$(db -At -c "select count(*) from $table")"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL $table: $actual rows, backup has $expected" >&2
    exit 1
  fi
done
echo "ok   $(unseal counts.tsv | wc -l) tables"

echo "--- smoke: the schema is intact"
db -At <<'SQL'
do $$
declare
  unprotected text;
begin
  if not exists (select 1 from supabase_migrations.schema_migrations) then
    raise exception 'no migration history';
  end if;
  if not exists (select 1 from vault.secrets where name = 'guest_token_secret') then
    raise exception 'guest_token_secret is missing';
  end if;
  select string_agg(c.relname, ', ') into unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity;
  if unprotected is not null then
    raise exception 'RLS is off on app.%', unprotected;
  end if;
end $$;
SQL
echo "ok   migrations, guest_token_secret, RLS on every app table"

echo "--- smoke: the API serves the restored data"
sleep 2 # PostgREST reloads its schema cache
slug="$(db -At -c 'select slug from app.locations order by created_at limit 1')"
if [ -n "$slug" ]; then
  status="$(curl -s -o "$work/public.json" -w '%{http_code}' -X POST "$API_URL/rest/v1/rpc/get_location_public" \
    -H "apikey: $ANON_KEY" -H 'content-type: application/json' -H 'content-profile: api' \
    -d "{\"p_location_slug\": \"$slug\"}")"
  [ "$status" = 200 ] || {
    echo "FAIL get_location_public($slug) as a guest: HTTP $status" >&2
    exit 1
  }
  echo "ok   a guest can open /q/$slug"

  # A restored owner, signed with the local JWT secret, sees exactly their org's locations.
  read -r user org expected < <(db -At -F ' ' -c "select m.user_id, m.org_id, (select count(*) from app.locations l where l.org_id = m.org_id) from app.memberships m where m.role = 'owner' order by m.created_at limit 1")
  token="$(node -e '
    const { createHmac } = require("node:crypto");
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: process.argv[1], role: "authenticated", aud: "authenticated", aal: "aal1", iat: now, exp: now + 300 })}`;
    console.log(`${body}.${createHmac("sha256", process.argv[2]).update(body).digest("base64url")}`);
  ' "$user" "$JWT_SECRET")"
  seen="$(curl -sf "$API_URL/rest/v1/locations?select=org_id" -H "apikey: $ANON_KEY" \
    -H "authorization: Bearer $token" -H 'accept-profile: app' |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const r=JSON.parse(s);console.log(r.every((l)=>l.org_id===process.argv[1])?r.length:-1)})' "$org")"
  [ "$seen" = "$expected" ] || {
    echo "FAIL an owner sees $seen of their $expected locations (-1: another org's too)" >&2
    exit 1
  }
  echo "ok   an owner reads their own $expected location(s) and no one else's"
else
  echo "skip API checks: the backup has no locations"
fi

e2e="${DRILL_E2E:-auto}"
if [ "$e2e" = auto ]; then
  e2e=0
  [ -n "$(db -At -c "select 1 from auth.users where email = 'owner@e2e.test'")" ] && e2e=1
fi
if [ "$e2e" = 1 ]; then
  echo "--- smoke: Playwright smoke spec against the restored database"
  E2E_SKIP_DB_RESET=1 pnpm exec playwright test tests/e2e/smoke.spec.ts --project=desktop-chrome
fi

echo "--- restore drill passed for backup $stamp"
