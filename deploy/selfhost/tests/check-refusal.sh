#!/usr/bin/env bash
# The stack refuses a published demo key (2P-OPS3 AC2, 2P-OPS7 AC3). Builds migrate, hands it the
# Supabase demo anon key in place of the real one and asserts it exits non-zero naming ANON_KEY.
# check-compose.sh asserts web, kong and functions wait for migrate, so none of them can start.
# Needs deploy/selfhost/.env (setup.sh) and docker; starts no other service (--no-deps).
set -euo pipefail
cd "$(dirname "$0")/.."

demo_anon='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE'
compose=(docker compose)
[[ -n ${COMPOSE_EXTRA_FILE:-} ]] && compose=(docker compose -f docker-compose.yml -f "$COMPOSE_EXTRA_FILE")

if out=$(ANON_KEY=$demo_anon "${compose[@]}" run --rm --no-deps migrate 2>&1); then
  echo "FAIL: migrate accepted the demo anon key" >&2
  exit 1
fi
grep -q 'check-secrets: ANON_KEY' <<<"$out" || { echo "FAIL: the refusal does not name ANON_KEY" >&2; echo "$out" >&2; exit 1; }
grep -qF "$demo_anon" <<<"$out" && { echo "FAIL: the refusal printed the key" >&2; exit 1; }
echo "check-refusal: ok"
