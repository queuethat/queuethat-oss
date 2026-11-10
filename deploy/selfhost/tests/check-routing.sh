#!/usr/bin/env bash
# Asserts the routing of a running stack (2P-OPS5, #211). Usage: check-routing.sh [BASE_URL] [ANON_KEY]
# Defaults: http://localhost and ANON_KEY from deploy/selfhost/.env.
set -euo pipefail
cd "$(dirname "$0")/.."
base=${1:-http://localhost}
anon=${2:-$(sed -n 's/^ANON_KEY=//p' .env)}
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

for path in /studio /studio/ /studio/project/default /pg /pg/tables /project /project/default; do
  [[ $(code "$base$path") == 404 ]] || bad "$path is not 404"
done

# The gateway answers API paths: no key is 401, a key reaches the service.
[[ $(code "$base/rest/v1/") == 401 ]] || bad "/rest/v1 without a key is not 401"
[[ $(code -H "apikey: $anon" "$base/auth/v1/health") == 200 ]] || bad "/auth/v1/health with a key is not 200"
[[ $(code "$base/functions/v1/health") == 200 ]] || bad "/functions/v1/health is not 200"

# Guest pages: no-referrer and a CSP, on a client route and on the SPA shell.
for path in /v/sometoken /q/some-queue /; do
  headers=$(curl -fsI "$base$path")
  grep -qi '^referrer-policy: no-referrer' <<<"$headers" || bad "$path: no no-referrer"
  grep -qi '^content-security-policy' <<<"$headers" || bad "$path: no CSP"
done
[[ $(curl -fs "$base/some/client/route" | grep -c '<div id="root">') == 1 ]] || bad "SPA fallback missing"

# A visitor can't choose the address the join rate limit sees: 40 joins with changing spoofed
# headers still hit the 30 a minute limit.
hits=0
for i in $(seq 1 40); do
  c=$(code -X POST -H "apikey: $anon" -H "X-Forwarded-For: 203.0.113.$i" -H "X-Real-IP: 198.51.100.$i" \
    -H 'Content-Type: application/json' -H 'Content-Profile: api' -d '{}' "$base/rest/v1/rpc/join_queue")
  [[ $c == 429 ]] && hits=$((hits + 1))
done
((hits >= 8)) || bad "spoofed X-Forwarded-For dodged the join rate limit (only $hits of 40 were 429)"

# The loop above used up this address's join allowance for the current minute. Kong counts in
# fixed one-minute windows, so wait for the next one: otherwise whatever joins next from this
# machine (the smoke journey's first guest) is refused with 429.
sleep $((61 - 10#$(date +%S)))

[[ $fail == 0 ]] && echo "check-routing: ok"
exit $fail
