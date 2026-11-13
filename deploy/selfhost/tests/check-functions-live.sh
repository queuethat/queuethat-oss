#!/usr/bin/env bash
# Invokes the functions that need no optional configuration (payments, LLM) once against the running stack (#41).
# A function that cannot boot answers 500 function_error (or 404 not_found when its files are
# missing); one that boots answers with its own status (401 without its secret, 400 for a bad
# body), so any other status counts as booted. Needs the stack from `docker compose up`.
# Usage: SELFHOST_PUBLIC_JOIN=pow (optional) SELFHOST_URL=http://localhost SELFHOST_ANON_KEY=... bash deploy/selfhost/tests/check-functions-live.sh
set -euo pipefail
url=${SELFHOST_URL:?set SELFHOST_URL}
key=${SELFHOST_ANON_KEY:?set SELFHOST_ANON_KEY}

fail=0
# public-join answers only when PUBLIC_JOIN (turnstile or pow) is set; without it guests join directly.
fns=(dispatch-notifications deliver-webhooks provider-webhook)
[[ -n "${SELFHOST_PUBLIC_JOIN:-}" ]] && fns+=(public-join)
for fn in "${fns[@]}"; do
  body=$(mktemp)
  status=$(curl -s -o "$body" -w '%{http_code}' -X POST "$url/functions/v1/$fn" \
    -H "apikey: $key" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d '{}')
  code=$(jq -r '.code // empty' "$body" 2>/dev/null || true)
  if [[ "$code" == function_error || "$code" == not_found || "$status" == 000 || "$status" == 502 || "$status" == 503 ]]; then
    echo "FAIL: $fn did not boot (HTTP $status ${code:-no code})" >&2
    fail=1
  else
    echo "ok: $fn booted (HTTP $status)"
  fi
  rm -f "$body"
done
exit "$fail"
