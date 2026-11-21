// Self-host gateway guard: an open Kong route for a function (no API key) is a plain path, and a
// plain path is a prefix match. A later function whose directory name starts with an open route's
// name (domain-check-admin after domain-check) would be reachable without a key. Kong 2.8 does not
// accept anchored regular expressions for these paths, so this fails the build instead.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Names of the open function routes in a kong.yml text: `/functions/v1/<name>` and nothing else. */
export function openRouteNames(kongYml) {
  return [...kongYml.matchAll(/^\s+- \/functions\/v1\/([a-z][a-z0-9-]*)\s*$/gm)].map((m) => m[1]);
}

/** Function directories that an open route's name is a prefix of (other than the route's own). */
export function shadowed(openNames, functionDirs) {
  const problems = [];
  for (const open of openNames) {
    for (const fn of functionDirs) {
      if (fn !== open && fn.startsWith(open)) problems.push({ open, fn });
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kong = readFileSync(join(root, 'deploy/selfhost/volumes/api/kong.yml'), 'utf8');
  const dir = join(root, 'supabase/functions');
  const functions = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'index.ts')))
    .map((d) => d.name);
  const open = openRouteNames(kong);
  if (open.length === 0) {
    console.error(
      'check-kong-open-routes: found no open function routes; the pattern is out of date',
    );
    process.exit(1);
  }
  const bad = shadowed(open, functions);
  for (const { open: o, fn } of bad) {
    console.error(
      `check-kong-open-routes: function "${fn}" starts with the open route "${o}" and would skip the API key. Rename it, or give the route another name.`,
    );
  }
  if (bad.length > 0) process.exit(1);
  console.log(`ok   Kong open routes (${open.join(', ')}) shadow no function`);
}
