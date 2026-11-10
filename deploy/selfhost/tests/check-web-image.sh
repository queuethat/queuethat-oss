#!/usr/bin/env bash
# Builds queue-web and checks 2P-OPS4 (#210) against the real image:
#   1. the same image, started with two different URLs, serves two different /config.js
#   2. the CSP needs no inline script, and the page has none
#   3. the image holds no service-role key, JWT secret or demo key (known-demo-keys.sha256 is hashes only)
#   4. a demo or service-role key as ANON_KEY stops the container
# Usage: bash deploy/selfhost/tests/check-web-image.sh [--no-build]
# --no-build checks an image that already exists: QM_WEB_IMAGE names it (default queue-web:test).
# After `docker compose up --build` that is queue-web:local.
set -euo pipefail
cd "$(dirname "$0")/../../.."

image=${QM_WEB_IMAGE:-queue-web:test}
if [[ ${1:-} == --no-build ]]; then
  docker image inspect "$image" >/dev/null 2>&1 || { echo "check-web-image: no image $image; build it or set QM_WEB_IMAGE" >&2; exit 1; }
else
  docker build -q -f apps/web/Dockerfile -t "$image" .
fi

work=$(mktemp -d)
names=()
cleanup() { for n in "${names[@]}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done; rm -rf "$work"; }
trap cleanup EXIT
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

env_file="$work/.env"
bash deploy/selfhost/setup.sh --non-interactive --env-file "$env_file" >/dev/null
anon=$(sed -n 's/^ANON_KEY=//p' "$env_file")
service=$(sed -n 's/^SERVICE_ROLE_KEY=//p' "$env_file")
secret=$(sed -n 's/^JWT_SECRET=//p' "$env_file")

start() { # start NAME URL [ANON_KEY]
  names+=("$1")
  docker run -d --name "$1" -e PUBLIC_URL="$2" -e SITE_ADDRESS=:80 -e ANON_KEY="${3:-$anon}" -p "127.0.0.1:${4:-0}:80" "$image" >/dev/null
}
port() { docker port "$1" 80/tcp | head -n 1 | sed 's/.*://'; }
wait_ready() { for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$(port "$1")/version.json" >/dev/null && return 0; sleep 1; done; return 1; }

start qm-web-a http://one.test
start qm-web-b http://two.test
wait_ready qm-web-a && wait_ready qm-web-b || { docker logs qm-web-a >&2; bad "containers did not start"; }

ca=$(curl -fs "http://127.0.0.1:$(port qm-web-a)/config.js")
cb=$(curl -fs "http://127.0.0.1:$(port qm-web-b)/config.js")
grep -q 'SUPABASE_URL: "http://one.test"' <<<"$ca" || bad "instance A does not talk to its own API"
grep -q 'SUPABASE_URL: "http://two.test"' <<<"$cb" || bad "instance B does not talk to its own API"
grep -q "$anon" <<<"$ca" || bad "config.js lacks the anon key"

headers=$(curl -fsI "http://127.0.0.1:$(port qm-web-a)/v/abc")
grep -qi '^content-security-policy-report-only:.*script-src .self. https://challenges.cloudflare.com https://js.stripe.com;' <<<"$headers" || bad "no script-src without unsafe-inline in the CSP"
grep -qi "unsafe-inline" <<<"$headers" && bad "the CSP allows unsafe-inline"
grep -qi 'connect-src .self. http://one.test ws://one.test' <<<"$headers" || bad "the CSP does not name this install's API origin"
curl -fs "http://127.0.0.1:$(port qm-web-a)/v/abc" | grep -Eq '<script(\s[^>]*)?>[^<]' && bad "index.html has an inline script"

# The image is built before any install exists, so no key can be in it; this guards against a
# secret creeping in through a build argument or a copied .env.
leaks=$(docker run --rm --entrypoint sh "$image" -c "grep -rIlF -e '$secret' -e '$service' /srv /etc/caddy /usr/local/share/queue || true")
[[ -z $leaks ]] || bad "the image holds a secret or demo key: $leaks"

for key in "$service" "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"; do
  if docker run --rm -e PUBLIC_URL=http://x.test -e ANON_KEY="$key" "$image" >/dev/null 2>"$work/err"; then
    bad "the container started with a key it must refuse"
  else
    grep -q ANON_KEY "$work/err" || bad "the refusal does not name ANON_KEY"
  fi
done

# A value that could end the JS string literal stops the container before config.js exists.
if docker run --rm -e PUBLIC_URL=http://x.test -e ANON_KEY="$anon" -e SENTRY_DSN='x";alert(1);//' "$image" >/dev/null 2>"$work/err"; then
  bad "the container started with a quote in SENTRY_DSN"
else
  grep -q SENTRY_DSN "$work/err" || bad "the refusal does not name SENTRY_DSN"
fi

[[ $fail == 0 ]] && echo "check-web-image: ok"
exit $fail
