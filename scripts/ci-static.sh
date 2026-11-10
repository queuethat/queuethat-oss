#!/usr/bin/env bash
# Static checks. Run by the `static` job in .github/workflows/ci.yml and by `pnpm ci:local`,
# so local and GitHub CI run exactly the same steps.
#
# Every step runs even when an earlier one fails, and the script fails at the end naming them.
# Stopping at the first red step (format:check, say, red on someone else's file) used to skip
# `pnpm build`, which holds the guest bundle budget (check-bundle-size), so a PR could cross the
# line and merge without anyone seeing it.
set -uo pipefail

failed=()
run() {
  echo "--- $*"
  "$@" || failed+=("$*")
}

run pnpm format:check
run node scripts/check-redefinitions.mjs
run node scripts/check-migrations.mjs
run node scripts/check-locales.mjs
run node scripts/check-test-clock.mjs
run bash scripts/check-function-logs.sh
run node scripts/check-answers-not-in-outbound.mjs
run pnpm lint
run pnpm typecheck
run pnpm test
run pnpm test:functions
run pnpm test:selfhost
# vite build, then check-bundle-size (guest routes under 160 KB gzip) and the other bundle guards.
# Measured with the local stack's real anon key, as Playwright's webServer builds it: an empty or
# dummy key gzips smaller and hides an overage. Without a running stack the check is the weaker one.
anon_key=$(pnpm exec supabase status -o env 2>/dev/null | sed -n 's/^ANON_KEY="\(.*\)"/\1/p')
if [ -n "$anon_key" ]; then
  export VITE_SUPABASE_URL=http://127.0.0.1:55321 VITE_SUPABASE_ANON_KEY="$anon_key"
else
  echo "warning: local Supabase is not running; bundle size measured without the real anon key" >&2
fi
run pnpm build

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'ci-static FAILED:\n' >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi
echo "ci-static passed"
