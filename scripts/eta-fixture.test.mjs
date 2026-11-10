import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ETA_MESSAGES_EN, formatEta } from '../packages/domain/src/eta.ts';

// 2B-W1 (#289): walk-in ETA scenarios shared by SQL and TS. The database computes the numbers
// (supabase/tests/eta/appointments.test.sql); formatEta only renders them.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const shared = JSON.parse(read('../tests/fixtures/eta.json'));

const t = (key, vars = {}) =>
  ETA_MESSAGES_EN[key].replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name]));

describe('shared ETA scenarios', () => {
  it.each(shared.scenarios.map((s) => [s.name, s.expect]))(
    'renders %s as the fixture says',
    (_n, e) => {
      expect(formatEta(e.state, e.low, e.high, t)).toBe(e.label);
    },
  );

  it('the SQL test carries a copy equal to tests/fixtures/eta.json', () => {
    const sql = read('../supabase/tests/eta/appointments.test.sql');
    const literal = /\$fixture\$([\s\S]*?)\$fixture\$/.exec(sql)?.[1];
    expect(JSON.parse(literal ?? 'null')).toEqual(shared);
  });
});
