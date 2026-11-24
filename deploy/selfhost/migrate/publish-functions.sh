#!/bin/sh
# Lays out supabase/functions for the self-host edge runtime (#41).
# Usage: sh publish-functions.sh SRC_ROOT DEST
#   SRC_ROOT holds supabase/functions, ee/{supabase/functions,integrations} (used only when QT_EE=1), packages/{domain,providers,db-types} and deploy/selfhost/functions-main.
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
# The enterprise functions (QueueThat Commercial License, see ee/LICENSE) are published only when the
# operator turned them on with QT_EE=1 (setup.sh --ee). Off, the stack runs AGPL code only. Their
# imports reach into ee/ and the core tree, so each path is mapped to where the volume holds it.
if [ "${QT_EE:-0}" = 1 ] && [ -d "$src/ee/supabase/functions" ]; then
  cp -R "$src/ee/supabase/functions/." "$dest/"
  [ -d "$src/ee/integrations" ] && cp -R "$src/ee/integrations" "$dest/ee-integrations"
  for dir in "$src"/ee/supabase/functions/*/; do
    name=$(basename "$dir")
    for f in "$dest/$name"/deno.json "$dest/$name"/*.ts; do
      [ -f "$f" ] && sed -i \
        -e 's#\.\./\.\./\.\./integrations/#../ee-integrations/#g' \
        -e 's#\.\./\.\./\.\./\.\./supabase/functions/_shared/#../_shared/#g' \
        -e 's#\.\./\.\./\.\./\.\./packages/#../packages/#g' "$f"
    done
  done
fi
find "$dest" -name '*.test.ts' -delete
for f in "$dest"/*/deno.json "$dest"/*/*.ts; do
  [ -f "$f" ] && sed -i 's#\.\./\.\./\.\./packages/#../packages/#g' "$f"
done
