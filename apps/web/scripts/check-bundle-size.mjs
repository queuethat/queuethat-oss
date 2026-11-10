// Fails the build when a guest route ships more than the budget of gzipped JS
// (technical-design.md 3.1; F7 #17). Guests open these pages on mobile data from a QR code.
//
// For each guest route, sums the entry chunk plus every chunk the route statically imports.
// Run after `vite build` (needs build.manifest = true).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 160 * 1024;
const GUEST_ROUTE_PREFIXES = [
  'src/routes/q/',
  'src/routes/w/',
  'src/routes/v/',
  'src/routes/u.tsx',
  'src/routes/b/',
  'src/routes/a/',
  'src/routes/o/',
];
// The hosted service's operator console is not part of this repository. If it is ever added
// back under these paths, it must never ship to guests.
const FORBIDDEN_PREFIXES = [
  'src/routes/platform/',
  'src/features/platform/',
  'src/layouts/PlatformLayout',
];

const dist = new URL('../dist/', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));

function collect(key, seen) {
  if (seen.has(key)) return;
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Manifest has no chunk ${key}`);
  seen.add(key);
  for (const dep of chunk.imports ?? []) collect(dep, seen);
}

const gzipSize = (key) => gzipSync(readFileSync(join(dist, manifest[key].file))).length;

const routes = Object.keys(manifest).filter((k) =>
  GUEST_ROUTE_PREFIXES.some((p) => k.startsWith(p)),
);
if (routes.length === 0) throw new Error('No guest routes found in the manifest');

let failed = false;
for (const route of routes) {
  const seen = new Set();
  collect('index.html', seen);
  collect(route, seen);
  // Layout routes are parents of the page route, so a page load pulls them in too.
  for (const layout of routes.filter(
    (r) => r.includes('/route.tsx') && route.startsWith(r.split('route.tsx')[0]),
  ))
    collect(layout, seen);
  const total = [...seen].reduce((sum, key) => sum + gzipSize(key), 0);
  const leaked = [...seen].filter((key) => FORBIDDEN_PREFIXES.some((p) => key.startsWith(p)));
  for (const key of leaked) console.log(`FAIL ${key} is loaded by guest route ${route}`);
  const ok = total <= BUDGET_BYTES && leaked.length === 0;
  failed ||= !ok;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${(total / 1024).toFixed(1)} KB gzip  ${route.split('?')[0]}`,
  );
}

if (failed) {
  console.error(`Guest route JS budget is ${BUDGET_BYTES / 1024} KB gzip.`);
  process.exit(1);
}
