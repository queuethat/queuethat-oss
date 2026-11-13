#!/usr/bin/env bash
# Guard for #41: every function the migrate image publishes can resolve all of its imports.
# Lays the functions out with publish-functions.sh (the script the image runs), using only what the
# migrate Dockerfile copies, then asks Deno to resolve each entry point. A missing module (for
# example packages/providers absent from the image) fails here instead of at first request.
# Needs deno (pnpm i installs it) and network for jsr/npm modules; no stack is started.
set -euo pipefail
cd "$(dirname "$0")/../../.."

# Resolved from the repository root: pnpm exec does not work from the temporary directory below.
DENO=${DENO:-$(pnpm bin)/deno}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Mirror the Dockerfile COPY lines: if a package is not copied there, it is not here.
mkdir -p "$work/app/supabase" "$work/app/packages" "$work/app/deploy/selfhost"
cp -R supabase/functions "$work/app/supabase/functions"
for pkg in $(sed -n 's#^COPY packages/\([a-z-]*\)/src .*#\1#p' deploy/selfhost/migrate/Dockerfile); do
  mkdir -p "$work/app/packages/$pkg"
  cp -R "packages/$pkg/src" "$work/app/packages/$pkg/src"
done
cp -R deploy/selfhost/functions-main "$work/app/deploy/selfhost/functions-main"
find "$work/app" -name '*.test.ts' -delete

sh deploy/selfhost/migrate/publish-functions.sh "$work/app" "$work/functions"

fail=0
count=0
for dir in "$work"/functions/*/; do
  name=$(basename "$dir")
  [[ -f "$dir/index.ts" ]] || continue
  count=$((count + 1))
  cfg=()
  [[ -f "$dir/deno.json" ]] && cfg=(--config "$dir/deno.json")
  if ! out=$(cd "$dir" && NO_COLOR=1 $DENO info "${cfg[@]}" index.ts 2>&1); then
    echo "FAIL: $name: deno could not resolve index.ts" >&2
    echo "$out" | tail -5 >&2
    fail=1
  elif grep -q '(missing)' <<<"$out"; then
    echo "FAIL: $name imports modules the image does not publish:" >&2
    grep '(missing)' <<<"$out" | sed "s#file://$work/##" | sort -u | head -5 >&2
    fail=1
  fi
done
((count > 0)) || { echo "FAIL: no functions found" >&2; fail=1; }
((fail == 0)) && echo "check-functions: $count functions resolve"
exit "$fail"
