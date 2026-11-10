// Fails when dist/ (or the directory given as the first argument) contains the /dev/inbox route
// while VITE_DEV_INBOX is not "true" (2P-NTF11, #183). Last step of `pnpm build`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hasDevInbox } from './dev-inbox-bundle.mjs';

const dist = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
const allowed = process.env.VITE_DEV_INBOX === 'true';

const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
if (files.length === 0) throw new Error(`No files in ${dist}; run vite build first`);

const found = files.filter((file) => hasDevInbox(readFileSync(file, 'utf8')));
if (found.length > 0 && !allowed) {
  for (const file of found) console.error(`FAIL ${relative(dist, file)} contains the dev inbox`);
  console.error('The /dev/inbox route must not ship. Build without VITE_DEV_INBOX=true.');
  process.exit(1);
}
console.log(`ok   dev inbox ${allowed ? 'allowed by VITE_DEV_INBOX' : 'absent from dist/'}`);
