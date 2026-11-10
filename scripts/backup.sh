#!/usr/bin/env bash
# O7 (#78): one encrypted database backup. Dumps roles, schema and data (auth included), plus the
# parts `supabase db dump` leaves out (migration history, Vault secrets, pg_cron jobs), encrypts
# each stream with age as it is written, uploads the set and keeps the newest BACKUP_KEEP.
# Plaintext never touches disk: every dump is piped straight into age. Run nightly by
# .github/workflows/backup.yml; docs/ops/backups.md has the setup and the restore steps.
#
# Required:
#   BACKUP_DB_URL         Postgres URL of the database (Supabase: the session pooler URL).
#   BACKUP_AGE_RECIPIENT  age public key (age1...) to encrypt to. Several, space-separated, allowed.
# Where to put it (one of):
#   BACKUP_S3_BUCKET      S3-compatible bucket (Cloudflare R2), with BACKUP_S3_ENDPOINT,
#                         AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Needs the aws CLI.
#   BACKUP_DIR            a local directory instead (drills and tests).
# Optional:
#   BACKUP_S3_PREFIX      key prefix, default "db/".
#   BACKUP_KEEP           how many backups to keep, default 14.
#   BACKUP_HEALTHCHECK_URL  Healthchecks.io ping URL; pinged on success, /fail on failure.
set -Eeuo pipefail
umask 077

: "${BACKUP_DB_URL:?set BACKUP_DB_URL}"
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT}"
keep="${BACKUP_KEEP:-14}"
prefix="${BACKUP_S3_PREFIX:-db/}"
if [ -z "${BACKUP_S3_BUCKET:-}" ] && [ -z "${BACKUP_DIR:-}" ]; then
  echo "set BACKUP_S3_BUCKET (with BACKUP_S3_ENDPOINT) or BACKUP_DIR" >&2
  exit 2
fi

ping() {
  [ -n "${BACKUP_HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_HEALTHCHECK_URL}$1" || true
}
trap 'ping /fail' ERR

# The repo's pinned CLI, never a global one: older CLIs can't parse our config.toml.
supabase=(pnpm --dir "$(dirname "$0")/.." exec supabase)
command -v age >/dev/null || {
  echo "age is not installed (Debian/Ubuntu: apt install age; macOS: brew install age)" >&2
  exit 2
}
recipients=()
for r in $BACKUP_AGE_RECIPIENT; do recipients+=(-r "$r"); done

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Every file in a backup goes through here: stdin is encrypted into $work/<name>.age.
seal() { age "${recipients[@]}" -o "$work/$1.age"; }
query() { psql "$BACKUP_DB_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

echo "--- dumping to $stamp"
"${supabase[@]}" db dump --db-url "$BACKUP_DB_URL" --role-only | seal roles.sql
"${supabase[@]}" db dump --db-url "$BACKUP_DB_URL" | seal schema.sql
"${supabase[@]}" db dump --db-url "$BACKUP_DB_URL" --data-only --use-copy | seal data.sql

# Migration history, so `supabase db push` against a restored project knows what is applied.
query "$(cat <<'SQL'
select format('insert into supabase_migrations.schema_migrations (version, name, statements)
               values (%L, %L, %L) on conflict do nothing;', version, name, statements)
from supabase_migrations.schema_migrations order by version
SQL
)" | seal migrations.sql

# Vault secrets (guest_token_secret and the others). Vault encrypts them with a key that stays
# with the project, so they can only be restored from their decrypted form, sealed like the rest.
query "$(cat <<'SQL'
select format($f$do $r$ begin
  if exists (select 1 from vault.secrets where name = %1$L) then
    perform vault.update_secret((select id from vault.secrets where name = %1$L), %2$L, %1$L, %3$L);
  else
    perform vault.create_secret(%2$L, %1$L, %3$L);
  end if;
end $r$;$f$, name, decrypted_secret, coalesce(description, ''))
from vault.decrypted_secrets order by name
SQL
)" | seal vault.sql

query "$(cat <<'SQL'
select format('select cron.schedule(%L, %L, %L);', jobname, schedule, command)
from cron.job order by jobname
SQL
)" | seal cron.sql

# Row counts per table, which the restore drill compares with what it restored.
query "$(cat <<'SQL'
select n.nspname || '.' || c.relname || E'\t' ||
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and not c.relispartition
  and n.nspname in ('app', 'private', 'ops', 'auth')
order by 1
SQL
)" | seal counts.tsv

for file in "$work"/*.age; do
  head -c 21 "$file" | grep -q '^age-encryption.org/v1' || {
    echo "$file is not an age file" >&2
    exit 1
  }
done
echo "--- sealed $(ls "$work" | wc -l) files, $(du -sh "$work" | cut -f1)"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  : "${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT}"
  s3() { aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 "$@"; }
  s3 cp --recursive --only-show-errors "$work/" "s3://$BACKUP_S3_BUCKET/$prefix$stamp/"
  # Stamps sort by time, so everything before the newest $keep goes.
  s3 ls "s3://$BACKUP_S3_BUCKET/$prefix" | awk '$1 == "PRE" { print $2 }' | sort | head -n "-$keep" |
    while read -r old; do
      echo "--- pruning $old"
      s3 rm --recursive --only-show-errors "s3://$BACKUP_S3_BUCKET/$prefix$old"
    done
else
  mkdir -p "$BACKUP_DIR/$stamp"
  mv "$work"/*.age "$BACKUP_DIR/$stamp/"
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??????Z' | sort | head -n "-$keep" |
    while read -r old; do
      echo "--- pruning $(basename "$old")"
      rm -rf "$old"
    done
fi

ping ""
echo "--- backup $stamp done"
