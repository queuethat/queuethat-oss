#!/usr/bin/env bats
# backup.sh retention and setup.sh --backup-key (2P-OPS10, #216). The backup-then-restore round
# trip needs a running stack: tests/check-backup.sh, run by the selfhost-smoke workflow.

setup() {
  DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
  WORK=$(mktemp -d)
}
teardown() { rm -rf "$WORK"; }

@test "AC3: 15 backups leave the newest 14" {
  for day in $(seq -w 1 15); do mkdir -p "$WORK/2026-10-${day}T030000Z"; touch "$WORK/2026-10-${day}T030000Z/db.dump.age"; done
  mkdir "$WORK/not-a-backup"
  run env BACKUP_DIR="$WORK" bash "$DIR/backup/backup.sh" prune
  [ "$status" -eq 0 ]
  [ "$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name '2026-*' | wc -l)" -eq 14 ]
  [ ! -e "$WORK/2026-10-01T030000Z" ]
  [ -d "$WORK/2026-10-15T030000Z" ]
  [ -d "$WORK/not-a-backup" ]
}

@test "BACKUP_KEEP changes how many stay, and fewer than that is left alone" {
  for day in 01 02 03; do mkdir -p "$WORK/2026-10-${day}T030000Z"; done
  run env BACKUP_DIR="$WORK" BACKUP_KEEP=5 bash "$DIR/backup/backup.sh" prune
  [ "$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 3 ]
  run env BACKUP_DIR="$WORK" BACKUP_KEEP=1 bash "$DIR/backup/backup.sh" prune
  [ "$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]
  [ -d "$WORK/2026-10-03T030000Z" ]
}

@test "a backup without a recipient key refuses to run and writes nothing" {
  run env BACKUP_DIR="$WORK" POSTGRES_PASSWORD=x BACKUP_AGE_RECIPIENT= bash "$DIR/backup/backup.sh" now
  [ "$status" -ne 0 ]
  [[ "$output" == *"BACKUP_AGE_RECIPIENT"* ]]
  [ -z "$(ls -A "$WORK")" ]
}

@test "setup.sh --backup-key prints the private key once and stores only the public key" {
  command -v age-keygen >/dev/null || skip "age-keygen is not installed"
  run "$DIR/setup.sh" --non-interactive --backup-key --env-file "$WORK/.env"
  [ "$status" -eq 0 ]
  secret=$(printf '%s\n' "$output" | grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' | head -n 1)
  [ -n "$secret" ]
  ! grep -q "AGE-SECRET-KEY" "$WORK/.env"
  recipient=$(sed -n 's/^BACKUP_AGE_RECIPIENT=//p' "$WORK/.env")
  [[ "$recipient" == age1* ]]
  [ "$(printf '%s\n' "$secret" | age-keygen -y)" = "$recipient" ]
  "$DIR/setup.sh" --non-interactive --rotate --env-file "$WORK/.env" >/dev/null
  [ "$recipient" = "$(sed -n 's/^BACKUP_AGE_RECIPIENT=//p' "$WORK/.env")" ]
}

@test "a clean setup leaves BACKUP_AGE_RECIPIENT empty" {
  "$DIR/setup.sh" --non-interactive --env-file "$WORK/.env"
  [ -z "$(sed -n 's/^BACKUP_AGE_RECIPIENT=//p' "$WORK/.env")" ]
}
