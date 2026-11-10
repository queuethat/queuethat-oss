#!/usr/bin/env bash
# 2P-OPS10 (#216): backup, wipe, restore on a running stack, then compare. Needs the stack from
# `docker compose up -d --wait` with BACKUP_AGE_RECIPIENT in .env, and the matching private key:
#   QM_BACKUP_KEY=qm-backup.key bash tests/check-backup.sh
# DESTROYS the stack's data (docker compose down -v) and restores it from the backup it just made.
# Afterwards run the smoke journey against the restored stack (the workflow does).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
key=${QM_BACKUP_KEY:?set QM_BACKUP_KEY to the age private key file}
set -a; . ./.env; set +a
bad() { echo "FAIL: $*" >&2; exit 1; }
export PGPASSWORD=$POSTGRES_PASSWORD
psql_db() { docker compose exec -T -e PGPASSWORD db psql -h localhost -U supabase_admin -d postgres -X -qtA -v ON_ERROR_STOP=1 "$@"; }
counts() { psql_db -c "select (select count(*) from app.organizations), (select count(*) from app.visits), (select count(*) from auth.users), (select count(*) from storage.objects)"; }

# A logo in storage and a visit in the database, so the restore has something to prove.
png=$(mktemp)
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x9a\xa0\xa0\x00\x00\x00\x00IEND\xaeB`\x82' >"$png"
want=$(sha256sum <"$png" | cut -d' ' -f1)
curl -fsS -X POST "http://localhost/storage/v1/object/branding/backup-check/logo.png" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: image/png' -H 'x-upsert: true' \
  --data-binary "@$png" -o /dev/null || bad "could not upload the logo"
queue=$(psql_db -c "select id from app.queues order by created_at limit 1")
[ -n "$queue" ] || bad "no queue to join; run the smoke journey first"
curl -fsS -X POST "http://localhost/rest/v1/rpc/join_queue" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -H 'Content-Profile: api' \
  -d "{\"p_queue_id\":\"$queue\",\"p_service_id\":null,\"p_name\":\"Backup check\",\"p_phone_e164\":null,\"p_email\":null,\"p_party_size\":1,\"p_locale\":\"en\",\"p_idempotency_key\":\"$(cat /proc/sys/kernel/random/uuid)\"}" -o /dev/null \
  || bad "could not join the queue"
before=$(counts)
echo "before: $before"

echo "--- backup"
docker compose --profile backup run --build --rm backup now
dir=$(find "${BACKUP_PATH:-./backups}" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??????Z' | sort | tail -n 1)
[ -n "$dir" ] || bad "no backup folder"
others=$(find "$dir" -type f ! -name '*.age' | wc -l)
[ "$others" = 0 ] || bad "$others file(s) in the backup are not .age"
[ "$(find "${BACKUP_PATH:-./backups}" -type f ! -name '*.age' | wc -l)" = 0 ] || bad "plaintext file in the backup folder"
if age -d -i <(age-keygen 2>/dev/null) "$dir/db.dump.age" >/dev/null 2>&1; then bad "a wrong key opened the dump"; fi
if grep -aq "backup-check" "$dir"/*.age; then bad "plaintext found in a backup file"; fi

echo "--- wipe and restore"
docker compose down -v >/dev/null 2>&1
bash ./restore.sh --identity "$key" --backup "$dir"
after=$(counts)
echo "after:  $after"
[ "$before" = "$after" ] || bad "row counts differ: $before vs $after"
got=$(curl -fsS "http://localhost/storage/v1/object/public/branding/backup-check/logo.png" | sha256sum | cut -d' ' -f1)
[ "$got" = "$want" ] || bad "the logo differs after the restore"
echo "check-backup: ok"
