#!/usr/bin/env bash
# Type-checks and unit-tests every Edge Function with the Deno that pnpm installs (pinned in
# package.json). Each function has its own deno.json, so run from inside its directory.
set -euo pipefail
cd "$(dirname "$0")/.."
deno="$(pwd)/node_modules/.bin/deno"
for dir in supabase/functions/*/; do
  [ -f "$dir/deno.json" ] || continue
  echo "--- ${dir}"
  (cd "$dir" && "$deno" check index.ts && "$deno" test --allow-net=127.0.0.1 --permit-no-files)
done
