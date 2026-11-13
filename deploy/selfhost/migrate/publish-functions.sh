#!/bin/sh
# Lays out supabase/functions for the self-host edge runtime (#41).
# Usage: sh publish-functions.sh SRC_ROOT DEST
#   SRC_ROOT holds supabase/functions, packages/{domain,providers,db-types} and deploy/selfhost/functions-main.
#   DEST is the functions volume.
# Functions import the workspace packages by a path relative to the repository
# (../../../packages/...); in the volume the packages sit beside the functions, so that prefix
# becomes ../packages/. The migrate entrypoint and deploy/selfhost/tests/check-functions.sh both
# run this script, so the test checks exactly what ships.
set -eu
src=$1
dest=$2

# A fresh copy each time, so a function deleted in a release disappears.
mkdir -p "$dest"
find "$dest" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$src/supabase/functions/." "$dest/"
mkdir -p "$dest/packages"
for pkg in domain providers db-types; do
  cp -R "$src/packages/$pkg" "$dest/packages/"
done
cp -R "$src/deploy/selfhost/functions-main" "$dest/main"
find "$dest" -name '*.test.ts' -delete
for f in "$dest"/*/deno.json "$dest"/*/*.ts; do
  [ -f "$f" ] && sed -i 's#\.\./\.\./\.\./packages/#../packages/#g' "$f"
done
