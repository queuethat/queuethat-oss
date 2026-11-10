#!/usr/bin/env bash
# Runs every check GitHub CI runs, on this machine: `pnpm ci:local`. That includes the whole
# browser suite, which GitHub runs on main after the merge; a pull request there runs only the
# core journeys (`pnpm test:e2e:core`).
# Use it before every handoff, and whenever GitHub Actions is unavailable.
# Needs Docker. In the Claude cloud container start it first: dockerd > /tmp/dockerd.log 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."

started_at=$(date -u +%H:%M:%SZ)
# A stale Vitest/Vite transform cache makes tests fail wholesale after a locale or config change on the base.
rm -rf node_modules/.vitest-cache node_modules/.vite apps/web/node_modules/.vite
echo "=== static"
bash scripts/ci-static.sh

echo "=== db"
if ! pnpm exec supabase status >/dev/null 2>&1; then
  bash scripts/retry-on-deadlock.sh pnpm exec supabase start -x studio,imgproxy,logflare,vector,edge-runtime,supavisor
fi
bash scripts/ci-db.sh

echo "=== e2e"
# The whole suite on the projects GitHub CI runs on a push to main. WebKit is not preinstalled in the Claude container:
# run `pnpm exec playwright install --with-deps webkit` once. E2E_PROJECTS overrides the list.
e2e_args=()
for project in ${E2E_PROJECTS:-desktop-chrome iphone}; do e2e_args+=("--project=$project"); done
pnpm test:e2e "${e2e_args[@]}"

# DS-5: screenshot baselines, alone and after the e2e run (it resets the database again).
echo "=== visual"
pnpm test:visual

echo "=== pr rules"
node .github/scripts/license-check.mjs
# CI_BASE=origin/<base-branch> (check-migrations defaults to origin/development) PR_TITLE="..." pnpm ci:local also runs the pr-checks.yml rules.
if [ -n "${CI_BASE:-}" ]; then
  BASE_SHA=$(git rev-parse "$CI_BASE") node .github/scripts/pr-checks.mjs
else
  echo "skipped title/size/migration rules: set CI_BASE to the PR's base branch"
fi

echo
echo "ci:local PASSED at $(git rev-parse --short HEAD) (started $started_at, finished $(date -u +%H:%M:%SZ))"
