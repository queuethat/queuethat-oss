#!/bin/sh
# Starts the web container: refuses a published or wrong-role anon key, writes /srv/config.js from
# the environment, derives the Caddy settings, then runs the command (caddy). POSIX sh.
set -eu

: "${PUBLIC_URL:?PUBLIC_URL is required, for example https://queue.example.com}"
: "${ANON_KEY:?ANON_KEY is required (setup.sh writes it)}"

# Only the anon key reaches this container. Without JWT_SECRET here, the check covers the hash
# list, the demo issuer and the role; the migrate service verifies the signature.
sh /usr/local/share/queue/check-secrets.sh ANON_KEY

PUBLIC_URL=${PUBLIC_URL%/}
SUPABASE_URL=${SUPABASE_URL:-$PUBLIC_URL}
export SUPABASE_URL

# Every value ends up inside a JS string literal in /srv/config.js. Quotes, backslashes, angle
# brackets and anything non-printable are refused (not escaped), checked before anything is
# written, so a value can never end the literal and run as code.
DEMO_MODE=${DEMO_MODE:-false}
for name in SUPABASE_URL ANON_KEY PUBLIC_URL DEMO_MODE VAPID_PUBLIC_KEY SENTRY_DSN SENTRY_ISSUES_URL AUTH_TURNSTILE_SITE_KEY PUBLIC_JOIN; do
  value=$(printenv "$name" || true)
  case $value in
    *[!\ -~]* | *\"* | *\\* | *\<*)
      echo "web: $name has a quote, backslash, angle bracket or control character; not started" >&2
      exit 1
      ;;
  esac
done
js_string() { printf '"%s"' "$1"; }

cat >/srv/config.js <<JS
// Written at container start from the environment. Public values only.
window.__APP_CONFIG__ = {
  SUPABASE_URL: $(js_string "$SUPABASE_URL"),
  SUPABASE_ANON_KEY: $(js_string "$ANON_KEY"),
  PUBLIC_URL: $(js_string "$PUBLIC_URL"),
  DEMO_MODE: $(js_string "$DEMO_MODE"),
  VAPID_PUBLIC_KEY: $(js_string "${VAPID_PUBLIC_KEY:-}"),
  SENTRY_DSN: $(js_string "${SENTRY_DSN:-}"),
  SENTRY_ISSUES_URL: $(js_string "${SENTRY_ISSUES_URL:-}"),
  AUTH_TURNSTILE_SITE_KEY: $(js_string "${AUTH_TURNSTILE_SITE_KEY:-}"),
  PUBLIC_JOIN: $(js_string "${PUBLIC_JOIN:-}")
};
JS

# Caddy: the site address is the public URL (an https name gets a certificate); behind a tunnel
# that terminates TLS, set SITE_ADDRESS=:80. The CSP names this install's API origin.
export SITE_ADDRESS=${SITE_ADDRESS:-$PUBLIC_URL}
export QM_TRUSTED_PROXIES=${QM_TRUSTED_PROXIES:-127.0.0.1/32}
export QM_API_ORIGIN=$SUPABASE_URL
case $SUPABASE_URL in
  https://*) export QM_API_WS_ORIGIN="wss://${SUPABASE_URL#https://}" ;;
  *) export QM_API_WS_ORIGIN="ws://${SUPABASE_URL#http://}" ;;
esac

exec "$@"
