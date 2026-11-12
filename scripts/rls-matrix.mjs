// Reads the RLS matrix: supabase/tests/rls/matrix.yaml plus any matrix.<name>.yaml a deployment
// adds (see compile-rls-matrix.mjs).
import { parse } from 'yaml';

export const BASE_ACTORS = [
  'anon',
  'owner',
  'admin',
  'manager',
  'staff',
  'display',
  'kiosk',
  'other_owner',
];

/**
 * Merges matrix.yaml with the matrix.<name>.yaml files (name order). Pure apart from `read`.
 * @param {string[]} names file names in tests/rls
 * @param {(name: string) => string} read
 */
export function loadMatrix(names, read) {
  const errors = [];
  const actors = [...BASE_ACTORS];
  const tables = {};
  const globalTables = [];
  const extras = names.filter((n) => /^matrix\.[\w-]+\.yaml$/.test(n)).sort();
  const pending = [];
  for (const name of ['matrix.yaml', ...extras]) {
    const m = parse(read(name)) ?? {};
    for (const a of m.actors ?? []) if (!actors.includes(a)) actors.push(a);
    globalTables.push(...(m.global_tables ?? []));
    for (const [t, entry] of Object.entries(m.tables ?? {})) {
      if (t in tables)
        errors.push(`${name}: ${t} is already listed; use allow_extra to add actors`);
      else tables[t] = structuredClone(entry);
    }
    for (const [t, ops] of Object.entries(m.allow_extra ?? {})) pending.push([name, t, ops]);
  }
  for (const [name, t, ops] of pending) {
    if (!tables[t]?.allow) {
      errors.push(`${name}: allow_extra names ${t}, which no matrix lists`);
      continue;
    }
    for (const [op, list] of Object.entries(ops)) {
      tables[t].allow[op] = [...new Set([...(tables[t].allow[op] ?? []), ...list])];
    }
  }
  return { actors, tables, globalTables, errors };
}
