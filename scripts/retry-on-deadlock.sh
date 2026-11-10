#!/usr/bin/env bash
# Runs a command that applies migrations (`supabase start`, `db reset`, `migration up`) and runs it
# again, up to three times in all, when it failed on a Postgres deadlock. Any other failure is
# passed straight through.
#
# Why: pg_cron starts running a job as soon as a migration schedules it, also while the rest of
# the migrations are still being applied. A job that locks two tables in one order can meet a
# migration that alters them in the other, and Postgres then cancels one of the two. When that is
# the migration, the command fails although nothing is wrong with it. This happened in CI:
# ops.enqueue_appointment_reminders (every 5 minutes) against 20261030214737_whatsapp_rules.sql.
# A migration is applied in one transaction, so running the command again is safe.
#
#   bash scripts/retry-on-deadlock.sh pnpm exec supabase db reset
set -uo pipefail

log=$(mktemp)
trap 'rm -f "$log"' EXIT
for attempt in 1 2 3; do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  grep -qE 'deadlock detected|SQLSTATE 40P01' "$log" || exit "$status"
  [ "$attempt" -lt 3 ] || exit "$status"
  echo "retry-on-deadlock: a scheduled job and a migration deadlocked (attempt $attempt of 3); running it again" >&2
  # A failed `supabase start` can leave containers behind that the next start refuses to reuse.
  case " $* " in
    *" start "*) pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true ;;
  esac
done
