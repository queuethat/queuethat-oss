// Catalog content lint (T2, #1296), run by ci-static.sh: every supabase/catalog/**/*.json template
// must pass lintTemplate (waivers/*.json: lintWaiver) (packages/domain/src/templates/catalog.ts). Fails the build on any problem.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { lintTemplate, lintWaiver } from '../packages/domain/src/templates/catalog.ts';

const root = 'supabase/catalog';

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith('.json')
        ? [join(dir, e.name)]
        : [],
  );
}

const errors: string[] = [];
const all = files(root);
for (const file of all) {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${file}: not valid JSON (${(e as Error).message})`);
    continue;
  }
  const lint = file.startsWith(`${root}/waivers/`) ? lintWaiver : lintTemplate;
  for (const problem of lint(json, basename(file, '.json'))) errors.push(`${file}: ${problem}`);
}
for (const e of errors) console.error(e);
if (errors.length) process.exit(1);
console.log(`Catalog templates checked: ${all.length} files.`);
