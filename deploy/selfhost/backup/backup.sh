#!/usr/bin/env bash
# Nightly encrypted backup of the self-host stack (2P-OPS10, #216).
#
#   backup.sh schedule   wait for BACKUP_TIME (UTC, default 03:00) every day and back up (the service)
#   backup.sh now        one backup, now
#   backup.sh prune      keep the newest BACKUP_KEEP (default 14) backups in /backups
#
# One folder per run, /backups/<UTC stamp>/, holding only `.age` files: db.dump.age (every schema,
# auth and storage metadata included, Vault secrets still encrypted), storage.tar.age (the uploaded
# files) and db-config.tar.age (the pgsodium key that decrypts the Vault secrets). Each stream is piped through age as it is produced, so no plaintext is ever
# written to disk. Without the age private key nothing in a backup can be read. The key file makes the
# backup self-contained: a restore needs the age private key and the install's .env, nothing else.
#
# Env: POSTGRES_PASSWORD, BACKUP_AGE_RECIPIENT (age1..., several allowed, space separated),
#      BACKUP_KEEP, BACKUP_TIME, BACKUP_RCLONE_REMOTE (e.g. r2:bucket/qm, configured with
#      RCLONE_CONFIG_* variables), BACKUP_HEALTHCHECK_URL (pinged on success, /fail on failure),
#      BACKUP_DIR (default /backups), BACKUP_STORAGE_DIR (default /storage).
set -Eeuo pipefail
umask 077

dir=${BACKUP_DIR:-/backups}
keep=${BACKUP_KEEP:-14}

ping() {
  [ -n "${BACKUP_HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_HEALTHCHECK_URL}$1" || true
}

prune() {
  # A run killed half way leaves ciphertext in a .partial folder; it must not fill the disk.
  find "$dir" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
  # busybox head has no negative counts, so count first.
  local all total
  all=$(find "$dir" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??????Z' | sort)
  total=$(printf '%s' "$all" | grep -c . || true)
  [ "$total" -gt "$keep" ] || return 0
  printf '%s\n' "$all" | head -n $((total - keep)) | while read -r old; do
    echo "backup: pruning $(basename "$old")"
    rm -rf "$old"
  done
}

now() {
  : "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT (setup.sh --backup-key generates a pair)}"
  : "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
  local recipients=() r
  for r in $BACKUP_AGE_RECIPIENT; do recipients+=(-r "$r"); done
  local stamp work
  stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
  # (Callers use `||`, which turns errexit off here, so every step that can fail says `|| return 1`.)
  # Written beside the final folder and renamed when complete, so a half backup is never listed.
  work="$dir/.partial-$stamp"
  trap 'rm -rf "$work"' RETURN
  mkdir -p "$work" || return 1
  echo "backup: dumping the database to $stamp"
  PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h db -U supabase_admin -d postgres -Fc |
    age "${recipients[@]}" -o "$work/db.dump.age" || return 1
  echo "backup: archiving the storage volume"
  tar -C "${BACKUP_STORAGE_DIR:-/storage}" -cf - . | age "${recipients[@]}" -o "$work/storage.tar.age" || return 1
  echo "backup: archiving the database key (Vault)"
  tar -C "${BACKUP_DB_CONFIG_DIR:-/db-config}" -cf - . | age "${recipients[@]}" -o "$work/db-config.tar.age" || return 1
  local f
  for f in "$work"/*.age; do
    head -c 21 "$f" | grep -q '^age-encryption.org/v1' || { echo "backup: $f is not an age file" >&2; return 1; }
  done
  mv "$work" "$dir/$stamp" || return 1
  trap - RETURN
  prune
  if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
    echo "backup: copying to the remote"
    rclone copy --quiet "$dir/$stamp" "${BACKUP_RCLONE_REMOTE%/}/$stamp" || return 1
  fi
  ping ""
  echo "backup: $stamp done"
}

schedule() {
  local at=${BACKUP_TIME:-03:00} target now_s wait
  case $at in [0-2][0-9]:[0-5][0-9]) ;; *) echo "backup: BACKUP_TIME must be HH:MM (UTC)" >&2; exit 2 ;; esac
  target=$((10#${at%%:*} * 3600 + 10#${at##*:} * 60))
  echo "backup: scheduled daily at $at UTC, keeping $keep"
  while true; do
    now_s=$((10#$(date -u +%H) * 3600 + 10#$(date -u +%M) * 60 + 10#$(date -u +%S)))
    wait=$((target - now_s))
    [ "$wait" -gt 0 ] || wait=$((wait + 86400))
    sleep "$wait"
    now || ping /fail
  done
}

case ${1:-schedule} in
  schedule) schedule ;;
  now) now || { ping /fail; exit 1; } ;;
  prune) prune ;;
  *) echo "usage: backup.sh schedule|now|prune" >&2; exit 2 ;;
esac
