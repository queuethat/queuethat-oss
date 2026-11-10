// Fails when dist/ (or the directory given as the first argument) contains a server-only
// secret (X-7, #74). Runs as the last step of `pnpm build`, so CI fails on a leak.
// Also checks the literal values of SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY and
// SENTRY_AUTH_TOKEN when they are set in the environment.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findSecrets } from './bundle-secrets.mjs';

const dist = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
const extraSecrets = [
  process.env.SUPABASE_JWT_SECRET,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  process.env.SENTRY_AUTH_TOKEN,
];

const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
if (files.length === 0) throw new Error(`No files in ${dist}; run vite build first`);

let failed = false;
for (const file of files) {
  for (const finding of findSecrets(readFileSync(file, 'utf8'), extraSecrets)) {
    failed = true;
    console.error(`FAIL ${relative(dist, file)}: ${finding}`);
  }
}

if (failed) {
  console.error('The web bundle is public. Server-only keys belong in Edge Function secrets.');
  process.exit(1);
}
console.log(`ok   no secrets in ${files.length} files under dist/`);
