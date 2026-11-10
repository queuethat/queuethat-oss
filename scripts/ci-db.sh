#!/usr/bin/env bash
# Database checks against a running local Supabase stack. Run by the `db` job in
# .github/workflows/ci.yml and by `pnpm ci:local`, so the two cannot drift.
set -euo pipefail

echo "--- db reset (migrations + seeds)"
pnpm db:reset

echo "--- compiled RLS matrix and allowlist are up to date"
pnpm db:compile-tests
git diff --exit-code -- supabase/tests || {
  echo "Run 'pnpm db:compile-tests' and commit the generated test files." >&2
  exit 1
}

echo "--- pgTAP"
pnpm exec supabase test db

echo "--- concurrency (real races over many connections)"
pnpm test:concurrency

echo "--- database lint"
pnpm exec supabase db lint --level error --fail-on error

echo "--- generated types are up to date"
pnpm db:types
git diff --exit-code -- packages/db-types || {
  echo "packages/db-types is out of date. Run 'pnpm db:reset && pnpm db:types' and commit the result." >&2
  exit 1
}

echo "--- generated consent texts are up to date"
pnpm gen:consent
git diff --exit-code -- packages/domain/src/generated || {
  echo "Consent texts are out of date. Run 'pnpm db:reset && pnpm gen:consent' and commit the result." >&2
  exit 1
}
