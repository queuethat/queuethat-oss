// T5 (#1299): catalog content ships twice, as the reviewed file (supabase/catalog/<key>.json, linted by
// scripts/check-templates.ts) and embedded in a content migration. This keeps the two identical, so what
// was reviewed is what tenants get. Waiver starters (supabase/catalog/waivers) are not migrated.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CATALOG = 'supabase/catalog';
const MIGRATIONS = 'supabase/migrations';
const BLOCK = /\$catalog\$([\s\S]*?)\$catalog\$/g;

const files = readdirSync(CATALOG)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(CATALOG, f), 'utf8')) as Record<string, unknown>);

const embedded = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .flatMap((f) =>
    [...readFileSync(join(MIGRATIONS, f), 'utf8').matchAll(BLOCK)].map((m) => ({
      migration: f,
      row: JSON.parse(m[1]!) as Record<string, unknown>,
    })),
  );

const id = (t: Record<string, unknown>) => `${String(t.key)} v${String(t.version)}`;

describe('catalog files and content migrations', () => {
  it('embed every catalog file exactly once', () => {
    for (const file of files) {
      const hits = embedded.filter((e) => id(e.row) === id(file));
      expect(
        hits.map((h) => h.migration),
        id(file),
      ).toHaveLength(1);
    }
  });

  it('embed each file verbatim, and nothing that has no file', () => {
    for (const { migration, row } of embedded) {
      // An older version stays in its merged migration once the file moves on to a newer one.
      const newer = files.find((f) => f.key === row.key && Number(f.version) > Number(row.version));
      if (newer) continue;
      const file = files.find((f) => id(f) === id(row));
      expect(file, `${migration}: ${id(row)} has no file in ${CATALOG}`).toBeDefined();
      expect(row, `${migration}: ${id(row)}`).toEqual(file);
    }
  });
});
