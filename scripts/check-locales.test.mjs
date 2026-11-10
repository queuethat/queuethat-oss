import { describe, expect, it } from 'vitest';
import { compareLocale } from './check-locales.mjs';

const en = { a: { b: 'x', c_one: '1', c_other: 'n' }, d: 'y' };

describe('compareLocale', () => {
  it('passes the same keys, whatever the plural forms', () => {
    expect(
      compareLocale('es/f.json', en, {
        a: { b: 'x', c_one: '1', c_many: 'm', c_other: 'n' },
        d: 'y',
      }),
    ).toEqual([]);
  });

  it('AC3: fails a key missing from the translation', () => {
    expect(compareLocale('es/f.json', en, { a: { b: 'x', c_other: 'n' } })).toEqual([
      'es/f.json: missing key d',
    ]);
  });

  it('fails a key English no longer has', () => {
    expect(compareLocale('es/f.json', en, { ...en, e: 'z' })).toEqual(['es/f.json: unknown key e']);
  });
});
