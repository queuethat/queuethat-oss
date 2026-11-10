#!/usr/bin/env bash
# Runs the K1 realtime spike against the LOCAL Supabase stack (`pnpm db:start`). See README.md.
#   bash deploy/load/run.sh [default|tuned] [guest counts...]
# default keeps the limits the CLI ships: realtime tenant 200 users and 100 events/s (the same numbers
# as the Cloud free plan) and Kong's 512 worker connections. tuned raises both, as a self-hoster would.
set -euo pipefail
cd "$(dirname "$0")"

mode=${1:-default}
shift || true
levels=("${@:-100 250 500}")
read -r -a levels <<<"${levels[*]}"

db() { docker exec -i supabase_db_queue-management psql -U postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
eval "$(pnpm exec supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"

case $mode in
  default) users=200 events=100 joins=100 kong=() ;;
  tuned) users=10000 events=10000 joins=1000 kong=(-e KONG_NGINX_EVENTS_WORKER_CONNECTIONS=8192) ;;
  *) echo "mode must be default or tuned" >&2; exit 2 ;;
esac
# The CLI's realtime container re-seeds its tenant (SEED_SELF_HOST) on boot, so restart first to
# clear cached limits, then write ours. _realtime belongs to supabase_admin; local superuser only.
docker restart supabase_realtime_queue-management >/dev/null
sleep 10
docker exec supabase_db_queue-management psql -U supabase_admin -d postgres -qc "update _realtime.tenants
  set max_concurrent_users = $users, max_events_per_second = $events, max_joins_per_second = $joins
  where external_id = 'realtime-dev'"
docker exec supabase_realtime_queue-management /app/bin/realtime rpc \
  'Realtime.Tenants.Cache.invalidate_tenant_cache("realtime-dev")' >/dev/null

# The CLI's Kong runs one nginx worker with 512 connections; a proxied socket uses two of them.
docker exec "${kong[@]}" supabase_kong_queue-management kong reload >/dev/null

# Approximate a 2 vCPU self-host box: the whole stack shares two cores; k6 runs on the others.
for c in $(docker ps --format '{{.Names}}' | grep '_queue-management$'); do
  docker update --cpuset-cpus 0,1 "$c" >/dev/null
done
k6_cpus=$(seq -s, 2 $(($(nproc) - 1)))

cat teardown.sql setup.sql | db
mkdir -p "results/$mode"
for n in "${levels[@]}"; do
  pulse_id=$(db -c "select loadtest.seed($n)")
  echo "=== $mode, $n guests"
  # Sample container CPU and memory through the run; keep each container's peak.
  (end=$((SECONDS + ${RAMP_S:-30} + 15 + ${WINDOW_S:-240}))
   while ((SECONDS < end)); do
     docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' | grep '_queue-management'
   done | awk '{ sub(/_queue-management/, "", $1); c = $2 + 0; m = $3
       if (c > cpu[$1]) cpu[$1] = c; mem[$1] = m }
     END { for (k in cpu) printf "%-12s peak_cpu=%.0f%% mem=%s\n", k, cpu[k], mem[k] }' \
     | sort >"results/$mode/guests-$n.stats.txt") &
  taskset -c "$k6_cpus" k6 run --quiet --no-usage-report \
    -e GUESTS="$n" -e PULSE_ID="$pulse_id" -e API_URL="$API_URL" \
    -e ANON_KEY="$ANON_KEY" -e SERVICE_KEY="$SERVICE_ROLE_KEY" \
    -e SUMMARY_OUT="results/$mode/guests-$n.json" pulse.js 2>"results/$mode/guests-$n.log" || true
  wait
done
db <teardown.sql
