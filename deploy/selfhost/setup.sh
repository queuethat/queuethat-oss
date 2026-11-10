#!/usr/bin/env bash
# Writes a complete .env with fresh secrets for the self-host stack (2P-OPS2, #208).
# Needs only bash and openssl. Never overwrites an existing .env unless --rotate.
#
#   ./setup.sh                              ask for the public URL, SMTP and sign-up mode
#   ./setup.sh --non-interactive [flags]    use flags and defaults (CI)
#
# Flags: --public-url URL  --signup open|invite  --smtp-host H --smtp-port P --smtp-user U
#        --smtp-pass W --smtp-from ADDR  --env-file PATH  --rotate  --non-interactive
#        --backup-key   generate an age key pair for the backup profile (prints the private key once)
#        --demo   seed the demo organization (DEMO_MODE=true, generated demo password)
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)

env_file="$here/.env"
interactive=1
rotate=0
demo=0
backup_key=0
public_url=""
signup=""
smtp_host="" smtp_port="587" smtp_user="" smtp_pass="" smtp_from=""

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }
need() { [ "$#" -ge 2 ] || { echo "setup: $1 needs a value" >&2; exit 2; }; }
while [ "$#" -gt 0 ]; do
  case $1 in
    --non-interactive) interactive=0 ;;
    --demo) demo=1 ;;
    --backup-key) backup_key=1 ;;
    --rotate) rotate=1 ;;
    --env-file) need "$@"; env_file=$2; shift ;;
    --public-url) need "$@"; public_url=$2; shift ;;
    --signup) need "$@"; signup=$2; shift ;;
    --smtp-host) need "$@"; smtp_host=$2; shift ;;
    --smtp-port) need "$@"; smtp_port=$2; shift ;;
    --smtp-user) need "$@"; smtp_user=$2; shift ;;
    --smtp-pass) need "$@"; smtp_pass=$2; shift ;;
    --smtp-from) need "$@"; smtp_from=$2; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "setup: unknown flag $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Values are written into .env, which compose parses and `check-secrets` reads. Refuse what could
# break that or run as shell if someone sources it, so only a plain character set is accepted.
# (Generated secrets are hex.)
safe_value() { # safe_value NAME VALUE
  case $2 in
    *[!A-Za-z0-9._~:/@+%=,-]*) echo "setup: $1 may only use letters, digits and . _ ~ : / @ + % = , -" >&2; exit 2 ;;
  esac
}

command -v openssl >/dev/null || { echo "setup: openssl is required" >&2; exit 1; }

if [ -e "$env_file" ] && [ "$rotate" = 0 ]; then
  echo "setup: $env_file exists and was left unchanged. Use --rotate to replace its secrets." >&2
  exit 1
fi

# On --rotate, settings the operator chose before are kept unless a flag says otherwise.
old() { [ -f "$env_file" ] && sed -n "s/^$1=//p" "$env_file" | head -n 1 || true; }
if [ "$rotate" = 1 ] && [ -f "$env_file" ]; then
  [ -n "$public_url" ] || public_url=$(old PUBLIC_URL)
  [ -n "$signup" ] || { [ "$(old DISABLE_SIGNUP)" = false ] && signup=open || signup=invite; }
  [ -n "$smtp_host" ] || { smtp_host=$(old SMTP_HOST); smtp_port=$(old SMTP_PORT); smtp_user=$(old SMTP_USER); smtp_pass=$(old SMTP_PASS); smtp_from=$(old SMTP_ADMIN_EMAIL); }
  keep_turnstile=$(old TURNSTILE_SECRET_KEY); keep_tunnel=$(old TUNNEL_TOKEN); keep_redirects=$(old ADDITIONAL_REDIRECT_URLS)
fi
[ "$demo" = 1 ] || { [ "$rotate" = 1 ] && [ "$(old DEMO_MODE)" = true ] && demo=1; } || true
keep_demo_password=$(old DEMO_PASSWORD)
keep_recipient=$(old BACKUP_AGE_RECIPIENT)
keep_recipient=${keep_recipient:-}
keep_turnstile=${keep_turnstile:-} keep_tunnel=${keep_tunnel:-} keep_redirects=${keep_redirects:-}

ask() { # ask VARNAME "prompt" default
  [ "$interactive" = 1 ] && [ -t 0 ] || return 0
  local reply
  read -r -p "$2${3:+ [$3]}: " reply || true
  printf -v "$1" '%s' "${reply:-${!1:-$3}}"
}
ask public_url "Public URL guests will use (https://queue.example.com)" "http://localhost"
public_url=${public_url:-http://localhost}
public_url=${public_url%/}
case $public_url in http://* | https://*) ;; *) echo "setup: --public-url must start with http:// or https://" >&2; exit 2 ;; esac
ask signup "Sign-up mode, open or invite" "invite"
signup=${signup:-invite}
case $signup in open) disable_signup=false ;; invite) disable_signup=true ;; *) echo "setup: --signup is open or invite" >&2; exit 2 ;; esac
ask smtp_host "SMTP host (blank to set up later)" ""
if [ -n "$smtp_host" ]; then
  ask smtp_port "SMTP port" "587"
  ask smtp_user "SMTP user" ""
  ask smtp_pass "SMTP password" ""
  ask smtp_from "From address" ""
fi

for pair in PUBLIC_URL:"$public_url" SMTP_HOST:"$smtp_host" SMTP_PORT:"$smtp_port" SMTP_USER:"$smtp_user" \
  SMTP_PASS:"$smtp_pass" SMTP_FROM:"$smtp_from"; do
  safe_value "${pair%%:*}" "${pair#*:}"
done

# Backups are encrypted to a public key; the private key is shown once and never stored here.
backup_recipient=$keep_recipient
backup_identity=""
if [ "$backup_key" = 0 ] && [ -z "$backup_recipient" ]; then
  ask want_key "Generate an encryption key pair for backups? (y/n)" "n"
  case ${want_key:-n} in y | Y | yes) backup_key=1 ;; esac
fi
if [ "$backup_key" = 1 ]; then
  command -v age-keygen >/dev/null || { echo "setup: age-keygen is required for --backup-key (macOS: brew install age; Debian/Ubuntu: apt install age)" >&2; exit 1; }
  backup_identity=$(age-keygen 2>/dev/null | grep '^AGE-SECRET-KEY-')
  backup_recipient=$(printf '%s\n' "$backup_identity" | age-keygen -y)
fi

hex() { openssl rand -hex "$1"; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Keep the database password on --rotate: Postgres sets it once, when the data volume is created.
postgres_password=$(hex 24)
if [ "$rotate" = 1 ] && [ -f "$env_file" ]; then
  kept=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file" | head -n 1)
  [ -z "$kept" ] || postgres_password=$kept
fi

jwt_secret=$(hex 32)
jwt() { # jwt ROLE: HS256 token valid for 10 years, signed with the new secret
  local now header payload sig
  now=$(date +%s)
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"queue-selfhost","iat":%s,"exp":%s}' "$1" "$now" $((now + 315360000)) | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$jwt_secret" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

# VAPID: a P-256 key pair; the public key is the raw 65-byte point, the private one the 32-byte scalar.
vapid_pem=$(openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null)
vapid_public=$(printf '%s' "$vapid_pem" | openssl ec -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)
vapid_private=$(printf '%s' "$vapid_pem" | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | b64url)
vapid_subject="mailto:${smtp_from:-admin@localhost}"

tmp=$(mktemp "$env_file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  echo "# Written by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Secrets: never commit or share this file."
  echo "PUBLIC_URL=$public_url"
  echo "ADDITIONAL_REDIRECT_URLS=$keep_redirects"
  echo "POSTGRES_PASSWORD=$postgres_password"
  echo "JWT_SECRET=$jwt_secret"
  echo "JWT_EXPIRY=3600"
  echo "ANON_KEY=$(jwt anon)"
  echo "SERVICE_ROLE_KEY=$(jwt service_role)"
  echo "SECRET_KEY_BASE=$(hex 64)"
  echo "VAULT_ENC_KEY=$(hex 16)"
  echo "PG_META_CRYPTO_KEY=$(hex 16)"
  echo "DASHBOARD_PASSWORD=$(hex 12)"
  echo "DISPATCH_SECRET=$(hex 32)"
  echo "REALTIME_DB_ENC_KEY=$(hex 8)"
  echo "DISABLE_SIGNUP=$disable_signup"
  echo "ENABLE_EMAIL_AUTOCONFIRM=false"
  echo "SMTP_HOST=$smtp_host"
  echo "SMTP_PORT=$smtp_port"
  echo "SMTP_USER=$smtp_user"
  echo "SMTP_PASS=$smtp_pass"
  echo "SMTP_ADMIN_EMAIL=$smtp_from"
  echo "SMTP_SENDER_NAME=QueueThat"
  echo "VAPID_PUBLIC_KEY=$vapid_public"
  echo "VAPID_PRIVATE_KEY=$vapid_private"
  echo "VAPID_SUBJECT=$vapid_subject"
  echo "TURNSTILE_SECRET_KEY=$keep_turnstile"
  echo "TUNNEL_TOKEN=$keep_tunnel"
  echo "BACKUP_AGE_RECIPIENT=$backup_recipient"
  if [ "$demo" = 1 ]; then
    # The seeded users keep the first password, so a rotation keeps it too.
    echo "DEMO_MODE=true"
    echo "DEMO_PASSWORD=${keep_demo_password:-$(hex 12)}"
  else
    echo "DEMO_MODE=false"
    echo "DEMO_PASSWORD="
  fi
} >"$tmp"

# The generated file must pass the check the services run at start. It is read, never sourced, and
# only its secrets reach the checker.
chk=()
while IFS='=' read -r name value; do
  case $name in JWT_SECRET | ANON_KEY | SERVICE_ROLE_KEY | POSTGRES_PASSWORD | DASHBOARD_PASSWORD | SECRET_KEY_BASE | VAULT_ENC_KEY | PG_META_CRYPTO_KEY | DISPATCH_SECRET | REALTIME_DB_ENC_KEY) chk+=("$name=$value") ;; esac
done <"$tmp"
env -i PATH="$PATH" "${chk[@]}" sh "$here/check-secrets.sh" >/dev/null

if [ -e "$env_file" ]; then
  backup="$env_file.bak-$(date -u +%Y%m%d%H%M%S)"
  cp "$env_file" "$backup"
  chmod 600 "$backup"
  echo "Previous .env kept as $backup (delete it once the new one works; it holds the old secrets)."
fi
chmod 600 "$tmp"
mv "$tmp" "$env_file"
trap - EXIT

echo "Wrote $env_file (mode 600)."
if [ -n "$backup_identity" ]; then
  cat <<MSG

BACKUP PRIVATE KEY. Shown once; this script does not keep it. Store it offline now (password manager
or paper). Without it no backup can be read; anyone who has it can read every backup.

  $backup_identity

Public key (already in .env as BACKUP_AGE_RECIPIENT): $backup_recipient
Start the nightly backups with: docker compose --profile backup up -d
MSG
fi
if [ "$demo" = 1 ]; then
  echo "Demo mode: sign in as owner@demo.test or staff@demo.test with the DEMO_PASSWORD in $env_file."
fi
if [ "$rotate" = 1 ]; then
  cat <<'MSG'

Rotated. What breaks:
  - everyone is signed out, and paired displays and kiosks must be paired again (new JWT secret);
  - push subscriptions stop until guests re-subscribe (new VAPID pair);
  - POSTGRES_PASSWORD was kept: the database only reads it when its volume is created.
Restart with: docker compose up -d --force-recreate
MSG
else
  echo "Next: docker compose up -d --wait"
fi
