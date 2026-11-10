// Guards `create or replace function` across parallel PRs. A migration that redefines a function
// must name the migration it copied the body from:
//
//   -- redefines private.join_core from 20261025003700_join_version_bump.sql
//
// and that must be the latest earlier migration defining it. If another PR redefined the function
// in between, the named file is stale, this check fails, and the author re-applies their change on
// top of the newer body instead of silently dropping it. Migrations up to CUTOFF are merged and
// immutable (I-12), so they are not checked.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CUTOFF = '20261025003800';

const DEFINE = /create\s+(?:or\s+replace\s+)?function\s+([a-z_][\w]*\.[a-z_][\w]*)\s*\(/gi;

/** Function names (schema.name, lower case) a migration defines. */
export function definedFunctions(sql) {
  return new Set([...sql.matchAll(DEFINE)].map((m) => m[1].toLowerCase()));
}

/**
 * Returns one error per redefinition in a migration after CUTOFF that does not name the latest
 * earlier migration defining that function.
 * @param {{ name: string, sql: string }[]} migrations sorted by name
 */
export function checkRedefinitions(migrations) {
  const lastDefiner = new Map();
  const errors = [];
  for (const { name, sql } of migrations) {
    const defined = definedFunctions(sql);
    if (name.slice(0, CUTOFF.length) > CUTOFF) {
      for (const fn of defined) {
        const previous = lastDefiner.get(fn);
        if (previous && !sql.includes(`-- redefines ${fn} from ${previous}`)) {
          errors.push(
            `${name}: redefines ${fn}, last defined in ${previous}. Re-apply your change on that ` +
              `body and add the line: -- redefines ${fn} from ${previous}`,
          );
        }
      }
    }
    for (const fn of defined) lastDefiner.set(fn, name);
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = 'supabase/migrations';
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
  const errors = checkRedefinitions(migrations);
  for (const e of errors) console.error(e);
  if (errors.length) process.exit(1);
  console.log(`Function redefinitions checked in ${migrations.length} migrations.`);
}
