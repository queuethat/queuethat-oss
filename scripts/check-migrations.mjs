// Guards migration ordering across parallel PRs (I-12). Two rules:
//
// 1. No two migrations share a timestamp prefix. Supabase orders by that prefix, and two PRs that
//    picked the same number both merge cleanly, then collide on `supabase db reset`.
// 2. Every migration that is not on the base branch sorts after the newest one there. Run it after
//    merging the latest base, as CONTRIBUTING.md requires.
//
// The base is CI_BASE when set, else origin/development.
// It is fetched first so a stale local ref can't hide a newer migration; if the fetch fails or the
// ref is missing (e.g. a shallow CI checkout), rule 2 is skipped with a warning.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = 'supabase/migrations';
const DEFAULT_BASE = 'origin/development';

const prefix = (name) => name.split('_')[0];

/** One error per timestamp prefix used by more than one migration. */
export function duplicatePrefixes(names) {
  const byPrefix = new Map();
  for (const name of names) {
    byPrefix.set(prefix(name), [...(byPrefix.get(prefix(name)) ?? []), name]);
  }
  return [...byPrefix.values()]
    .filter((group) => group.length > 1)
    .map((group) => `migrations share a timestamp prefix: ${group.join(', ')}. Rename yours.`);
}

/** One error per migration missing from the base that does not sort after the base's newest. */
export function notAfterBase(names, baseNames) {
  const onBase = new Set(baseNames);
  const latest = [...baseNames].sort().at(-1);
  if (!latest) return [];
  return names
    .filter((name) => !onBase.has(name) && prefix(name) <= prefix(latest))
    .map(
      (name) =>
        `${name} must sort after ${latest}, the newest migration on the base. Merge the latest ` +
        `base and rename it to a later timestamp.`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const errors = duplicatePrefixes(names);

  const base = process.env.CI_BASE || DEFAULT_BASE;
  const [remote, ...branch] = base.split('/');
  try {
    git('fetch', '--quiet', remote, branch.join('/'));
  } catch {
    console.warn(`check-migrations: could not fetch ${base}; using the local ref.`);
  }
  let baseNames = null;
  try {
    baseNames = git('ls-tree', '--name-only', base, `${MIGRATIONS_DIR}/`)
      .split('\n')
      .filter((p) => p.endsWith('.sql'))
      .map((p) => p.slice(MIGRATIONS_DIR.length + 1));
  } catch {
    console.warn(`check-migrations: ${base} not found; skipped the sort-after-base rule.`);
  }
  if (baseNames) errors.push(...notAfterBase(names, baseNames));

  for (const e of errors) console.error(e);
  if (errors.length) process.exit(1);
  console.log(`Migration order checked in ${names.length} migrations against ${base}.`);
}
