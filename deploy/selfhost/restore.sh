#!/usr/bin/env bash
# Restores a backup made by the backup profile into a FRESH self-host stack (2P-OPS10, #216).
#
#   ./restore.sh --identity qm-backup.key [--backup backups/2026-10-30T031500Z] [--yes]
#
# Needs the install's .env from before (its JWT keys must match the ones the app was using, or
# every signed-in session and paired display stops working) and the age private key.
# --backup defaults to the newest folder in ./backups. It stops if the database already holds data
# unless --yes is given, because the restore replaces it. Decrypted data flows only through pipes.
set -Eeuo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

identity="" backup="" yes=0
while [ $# -gt 0 ]; do
  case $1 in
    --identity) identity=${2:?--identity needs a file}; shift ;;
    --backup) backup=${2:?--backup needs a folder}; shift ;;
    --yes) yes=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "restore: unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$identity" ] && [ -f "$identity" ] || { echo "restore: --identity must be the age private key file" >&2; exit 2; }
[ -f .env ] || { echo "restore: no .env here. Put the previous install's .env next to this script first." >&2; exit 1; }
command -v age >/dev/null || { echo "restore: age is required (macOS: brew install age; Debian/Ubuntu: apt install age)" >&2; exit 1; }
if [ -z "$backup" ]; then
  backup=$(find "${BACKUP_PATH:-./backups}" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??????Z' | sort | tail -n 1)
fi
[ -n "$backup" ] && [ -f "$backup/db.dump.age" ] && [ -f "$backup/storage.tar.age" ] && [ -f "$backup/db-config.tar.age" ] || { echo "restore: no complete backup found" >&2; exit 1; }
echo "restore: using $backup"

# Consent first, before anything is written: the restore replaces the database, and the Vault key
# that goes with it. A db container or data volume that already exists counts as a populated stack.
pw=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n 1)
export PGPASSWORD=$pw
psql_db() { docker compose exec -T -e PGPASSWORD db psql -h localhost -U supabase_admin -d postgres -X -qtA -v ON_ERROR_STOP=1 "$@"; }
existing=$(docker compose ps -aq db)
if [ -z "$existing" ] && [ -n "$(docker volume ls -q --filter "name=^${COMPOSE_PROJECT_NAME:-queue}_db-data$")" ]; then
  existing=volume
fi
if [ -n "$existing" ] && [ "$yes" = 0 ]; then
  docker compose up -d --wait db
  used=$(psql_db -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('app', 'auth') and c.relkind = 'r'")
  if [ "$used" != 0 ]; then
    echo "restore: this stack already has data and the restore would replace it. Use a fresh stack, or pass --yes." >&2
    exit 1
  fi
fi

# The Vault key goes back before the database first starts; without it every Vault secret
# (guest_token_secret, the dispatcher key) is unreadable.
if [ -z "$existing" ]; then
  age -d -i "$identity" "$backup/db-config.tar.age" |
    docker compose run --rm --no-deps -T --entrypoint sh db -c 'tar -C /etc/postgresql-custom -xf -'
fi
# Only the database first: the dump brings auth, storage and the migration history with it, so the
# services start on the restored data afterwards and find nothing left to migrate.
docker compose up -d --wait db

echo "restore: database"
# pg_restore's messages can quote rows (a failed COPY names the line), so they stay in a private
# temp file that is deleted on exit, and only the count is shown.
log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0
age -d -i "$identity" "$backup/db.dump.age" |
  docker compose exec -T -e PGPASSWORD db pg_restore -h localhost -U supabase_admin -d postgres --clean --if-exists 2>"$log" || status=$?
# Exit 1 with "errors ignored" is the normal end on a fresh stack (roles and objects that the
# services create themselves already exist); anything else is a failed restore.
if [ "$status" -ne 0 ] && ! grep -q "errors ignored on restore" "$log"; then
  echo "restore: pg_restore failed (exit $status)" >&2
  exit 1
fi
echo "restore: $(grep 'errors ignored' "$log" || echo 'no errors')"

echo "restore: uploaded files"
age -d -i "$identity" "$backup/storage.tar.age" |
  docker compose run --rm --no-deps -T --entrypoint sh storage -c 'tar -C /var/lib/storage -xf -'

echo "restore: starting the stack"
docker compose up -d --wait
echo "restore: done. Check that you can sign in, then run the smoke checks in docs/selfhost/backups.md."
