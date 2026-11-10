import { describe, expect, it } from 'vitest';
import { cell, waiversToCsv } from './csv.ts';
import type { WaiverExport } from './api.ts';

describe('waiver export csv', () => {
  it('neutralises formulas and quotes separators', () => {
    expect(cell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(cell('+1')).toBe("'+1");
    expect(cell('@sum')).toBe("'@sum");
    expect(cell('Lee, Ann')).toBe('"Lee, Ann"');
    expect(cell(null)).toBe('');
    expect(cell(3)).toBe('3');
  });

  it('writes one row per record in the location time zone', () => {
    const data: WaiverExport = {
      timezone: 'America/Phoenix',
      truncated: false,
      rows: [
        {
          acceptedAt: '2026-11-09T16:42:00Z',
          signedAt: null,
          form: 'Studio waiver',
          version: 3,
          agreement: 'Waiver',
          textHash: 'a'.repeat(64),
          typedName: '-Ann Lee',
          guardianName: null,
          guestName: 'Ann',
          subject: 'visit',
        },
      ],
    };
    const lines = waiversToCsv(['When', 'Form'], data).trimEnd().split('\r\n');
    expect(lines[0]).toBe('When,Form');
    expect(lines[1]).toBe(
      `2026-11-09 09:42,Studio waiver,3,Waiver,Ann,'-Ann Lee,,,visit,${'a'.repeat(64)}`,
    );
  });
});
