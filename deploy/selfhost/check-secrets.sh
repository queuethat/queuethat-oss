#!/bin/sh
# Refuses to let the stack start with a published, empty or weak secret (2P-OPS2, #208).
# Reads the variables from the environment (compose passes .env), never from a file, so the same
# script runs in the migrate service, the web entrypoint and on the host. POSIX sh plus openssl.
#
#   check-secrets.sh                  check every secret that is set; the core ones must be set
#   check-secrets.sh ANON_KEY ...     check only these variables (the web image has no JWT_SECRET)
#
# Exit 0 when all pass, 1 otherwise. Prints the NAME of each failing variable and why, never a value.
# Known values are compared by sha256 against known-demo-keys.sha256, so the list is no leaderboard
# of working keys.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
known="${KNOWN_DEMO_KEYS:-$here/known-demo-keys.sha256}"
fail=0

bad() { echo "check-secrets: $1 $2" >&2; fail=1; }
get() { printenv "$1" 2>/dev/null || true; }
sha() { printf '%s' "$1" | openssl dgst -sha256 | sed 's/^.*= *//'; }
b64url_decode() {
  s=$(printf '%s' "$1" | tr '_-' '/+')
  case $((${#s} % 4)) in 2) s="$s==" ;; 3) s="$s=" ;; esac
  printf '%s' "$s" | openssl base64 -d -A 2>/dev/null
}
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# not_published NAME: the value's hash must not be on the list of published Supabase demo values.
not_published() {
  h=$(sha "$(get "$1" | tr -d ' \t\r\n')")
  if [ -f "$known" ] && grep -qix "$h" "$known"; then bad "$1" "is a published Supabase demo value; run ./setup.sh"; fi
}

# min_length NAME N: set and at least N characters.
min_length() {
  v=$(get "$1")
  if [ -z "$v" ]; then bad "$1" "is empty; run ./setup.sh"; return 1; fi
  if [ "${#v}" -lt "$2" ]; then bad "$1" "is shorter than $2 characters"; return 1; fi
}

# check_jwt NAME ROLE: a JWT of that role, not from the demo issuer, signed by JWT_SECRET when known.
check_jwt() {
  v=$(get "$1")
  if [ -z "$v" ]; then bad "$1" "is empty; run ./setup.sh"; return; fi
  not_published "$1"
  header=${v%%.*}; rest=${v#*.}; payload=${rest%%.*}; sig=${rest#*.}
  if [ "$rest" = "$v" ] || [ "$sig" = "$rest" ]; then bad "$1" "is not a JWT"; return; fi
  claims=$(b64url_decode "$payload" || true)
  case $claims in *'"iss":"supabase-demo"'*) bad "$1" "has iss supabase-demo (a published demo key)" ;; esac
  case $claims in *"\"role\":\"$2\""*) ;; *) bad "$1" "does not carry role $2" ;; esac
  secret=$(get JWT_SECRET)
  if [ -n "$secret" ]; then
    want=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
    [ "$want" = "$sig" ] || bad "$1" "is not signed with JWT_SECRET"
  fi
}

check() {
  case $1 in
    JWT_SECRET) not_published JWT_SECRET; min_length JWT_SECRET 40 || true ;;
    ANON_KEY) check_jwt ANON_KEY anon ;;
    SERVICE_ROLE_KEY) check_jwt SERVICE_ROLE_KEY service_role ;;
    POSTGRES_PASSWORD) not_published POSTGRES_PASSWORD; min_length POSTGRES_PASSWORD 24 || true ;;
    DASHBOARD_PASSWORD) not_published DASHBOARD_PASSWORD; min_length DASHBOARD_PASSWORD 16 || true ;;
    SECRET_KEY_BASE) min_length SECRET_KEY_BASE 64 || true ;;
    VAULT_ENC_KEY) not_published VAULT_ENC_KEY; min_length VAULT_ENC_KEY 32 || true ;;
    PG_META_CRYPTO_KEY) not_published PG_META_CRYPTO_KEY; min_length PG_META_CRYPTO_KEY 32 || true ;;
    DISPATCH_SECRET) min_length DISPATCH_SECRET 32 || true ;;
    REALTIME_DB_ENC_KEY) not_published REALTIME_DB_ENC_KEY; min_length REALTIME_DB_ENC_KEY 16 || true ;;
    *) echo "check-secrets: unknown variable $1" >&2; fail=1 ;;
  esac
}

if [ "$#" -gt 0 ]; then
  for name in "$@"; do check "$name"; done
else
  for name in JWT_SECRET ANON_KEY SERVICE_ROLE_KEY POSTGRES_PASSWORD DASHBOARD_PASSWORD SECRET_KEY_BASE \
    VAULT_ENC_KEY PG_META_CRYPTO_KEY DISPATCH_SECRET REALTIME_DB_ENC_KEY; do
    check "$name"
  done
fi

[ "$fail" = 0 ] && echo "check-secrets: ok"
exit "$fail"
