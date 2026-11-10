#!/usr/bin/env bash
# Guards for deploy/selfhost/docker-compose.yml (2P-OPS1, #207). Needs docker and jq; no stack is started.
#   1. every third-party image is pinned tag@sha256:digest (images built from this repo are exempt)
#   2. the default profile publishes only 80 and 443
#   3. every published port, in any profile, is 80, 443 or on 127.0.0.1
#   4. Studio, Postgres and the gateway are never published on a public address
#   5. web, kong and functions depend on migrate completing successfully
set -euo pipefail
cd "$(dirname "$0")/.."

# Placeholder values only so interpolation succeeds; nothing here is a real secret.
export POSTGRES_PASSWORD=x PUBLIC_URL=http://localhost JWT_SECRET=x ANON_KEY=x SERVICE_ROLE_KEY=x \
  SECRET_KEY_BASE=x PG_META_CRYPTO_KEY=x TUNNEL_TOKEN=x VAULT_ENC_KEY=x DISPATCH_SECRET=x DASHBOARD_PASSWORD=x REALTIME_DB_ENC_KEY=x

fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

all=$(docker compose --profile '*' config --format json)
default=$(docker compose config --format json)

while IFS=$'\t' read -r svc image; do
  [[ "$image" == *@sha256:* ]] || bad "$svc: image '$image' has no digest"
done < <(jq -r '.services | to_entries[] | select(.value.build == null) | [.key, .value.image] | @tsv' <<<"$all")

published() { jq -r '.services | to_entries[] | .key as $s | (.value.ports // [])[] | [$s, (.host_ip // ""), .published, .target] | map(tostring) | join("|")'; }

while IFS="|" read -r svc ip port target; do
  [[ "$port" == 80 || "$port" == 443 ]] || bad "default profile: $svc publishes $port"
  [[ -z "$ip" || "$ip" == 0.0.0.0 ]] || bad "default profile: $svc binds $ip:$port; Caddy must listen on every address"
done < <(published <<<"$default")

while IFS="|" read -r svc ip port target; do
  [[ "$port" == 80 || "$port" == 443 || "$ip" == 127.0.0.1 ]] || bad "$svc publishes $port on '${ip:-all addresses}'"
  case "$target" in 5432 | 6543 | 8000 | 8443 | 3000) [[ "$ip" == 127.0.0.1 ]] || bad "$svc exposes internal port $target" ;; esac
done < <(published <<<"$all")

# 5. the services that serve traffic start only after migrate (and so check-secrets) succeeded
for svc in web kong functions; do
  [[ $(jq -r --arg s "$svc" '.services[$s].depends_on.migrate.condition // ""' <<<"$all") == service_completed_successfully ]] \
    || bad "$svc does not wait for migrate to complete successfully"
done

[[ $fail == 0 ]] && echo "check-compose: ok"
exit $fail
