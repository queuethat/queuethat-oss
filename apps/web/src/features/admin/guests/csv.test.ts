import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, toCsv } from './csv.ts';

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",z\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
  });
  it('drops a byte-order mark and keeps empty cells', () => {
    expect(parseCsv('﻿name,phone\nAnn,')).toEqual([
      ['name', 'phone'],
      ['Ann', ''],
    ]);
  });
});

describe('toCsv', () => {
  it('round-trips awkward values', () => {
    const rows = [['a,b', 'q"uote', 'line\nbreak', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('defuses spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('Ann')).toBe('Ann');
  });
});
