import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// English eta strings are code (locales/en/eta.ts, from packages/domain), not JSON.
const NO_JSON_EN = new Set(['eta.json']);
const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Flattens nested JSON to dotted keys, with plural suffixes folded away (languages differ in forms). */
export function flatKeys(json, prefix = '') {
  const keys = new Set();
  for (const [key, value] of Object.entries(json)) {
    const path = prefix + key.replace(PLURAL, '');
    if (value && typeof value === 'object') {
      for (const inner of flatKeys(value, `${path}.`)) keys.add(inner);
    } else keys.add(path);
  }
  return keys;
}

/**
 * Problems between a locale's file and English's: keys missing from it (they would silently show
 * English) or present only in it (renamed or deleted in English).
 */
export function compareLocale(name, en, other) {
  const want = flatKeys(en);
  const have = flatKeys(other);
  return [
    ...[...want].filter((k) => !have.has(k)).map((k) => `${name}: missing key ${k}`),
    ...[...have].filter((k) => !want.has(k)).map((k) => `${name}: unknown key ${k}`),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = 'apps/web/src/locales';
  const errors = [];
  let files = 0;
  for (const locale of readdirSync(root).filter((d) => d !== 'en' && !d.includes('.'))) {
    for (const file of readdirSync(join(root, locale)).filter((f) => f.endsWith('.json'))) {
      let en;
      try {
        en = JSON.parse(readFileSync(join(root, 'en', file), 'utf8'));
      } catch {
        if (NO_JSON_EN.has(file)) continue;
        errors.push(`${locale}/${file}: no English file ${file}`);
        continue;
      }
      files++;
      errors.push(
        ...compareLocale(
          `${locale}/${file}`,
          en,
          JSON.parse(readFileSync(join(root, locale, file), 'utf8')),
        ),
      );
    }
  }
  for (const e of errors) console.error(e);
  if (errors.length) process.exit(1);
  console.log(`Locale keys checked in ${files} files.`);
}
