#!/usr/bin/env bash
# 2P-OPS12 (#218): Edge Functions log only through supabase/functions/_shared/log.ts, which redacts
# contact data and tokens. A raw console call anywhere else fails the build. Tests may spy on console.
set -euo pipefail
cd "$(dirname "$0")/.."
bad="$(grep -rnE 'console\.(log|error|warn|info|debug)' supabase/functions \
  --include='*.ts' --exclude='*.test.ts' --exclude='log.ts' || true)"
if [ -n "$bad" ]; then
  echo "Raw console calls in Edge Functions (use logInfo/logError from _shared/log.ts):" >&2
  echo "$bad" >&2
  exit 1
fi
