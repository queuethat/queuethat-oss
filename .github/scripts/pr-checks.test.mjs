import { describe, expect, it } from 'vitest';
import { findViolations, isAllowed } from './license-check.mjs';
import {
  checkFocusedTests,
  checkMigrations,
  checkSize,
  checkTitle,
  deletesDbTests,
  parseAddedLines,
  parseNameStatus,
  parseNumstat,
} from './pr-checks-lib.mjs';

// Built at runtime so this file's own source never trips the focused-test check.
const call = (fn, modifier, rest = "('x', () => {})") => `${fn}.${modifier}${rest}`;

describe('checkTitle', () => {
  it.each([
    'feat(web): join page [J-1]',
    'fix(db): lock ticket numbering [J-3, S-11]',
    'chore(infra): add governance checks [X-7]',
    'ci(infra,security): pin actions',
    'feat(db)!: change join_queue return type',
  ])('accepts %s', (title) => {
    expect(checkTitle(title)).toEqual([]);
  });

  it.each([
    'Add governance',
    'feat: missing area',
    'feature(web): wrong type',
    'feat(Web): caps area',
    'feat(web):no space',
  ])('rejects %s', (title) => {
    expect(checkTitle(title)).toHaveLength(1);
  });
});

describe('checkSize', () => {
  const generated = new Set(['pnpm-lock.yaml', 'packages/db-types/src/database.types.ts']);
  const isGenerated = (p) => generated.has(p);
  const numstat = parseNumstat(
    [
      '300\t200\tapps/web/src/routes/q/index.tsx',
      '5000\t10\tpnpm-lock.yaml',
      '900\t0\tpackages/db-types/src/database.types.ts',
      '700\t0\tapps/web/src/locales/fr.json',
      '-\t-\tapps/web/public/logo.png',
    ].join('\n'),
  );

  // AC1, as amended by the maintainer's 2026-10-25 merge policy: over the limit warns instead of failing.
  it('warns on a 500-line PR, counting neither generated, locale nor binary files', () => {
    const result = checkSize(numstat, { isGenerated, labels: [] });
    expect(result.total).toBe(500);
    expect(result.warnings).toHaveLength(1);
  });

  it('does not warn on the same PR with size:override', () => {
    expect(checkSize(numstat, { isGenerated, labels: ['size:override'] }).warnings).toEqual([]);
  });

  it('passes at exactly 400 lines', () => {
    const atLimit = parseNumstat('400\t0\tapps/web/src/a.ts');
    expect(checkSize(atLimit, { isGenerated, labels: [] }).warnings).toEqual([]);
  });
});

describe('checkMigrations', () => {
  const base = ['20261025000100_init_schemas.sql', '20261026000100_visits.sql'];
  const changes = (text) => parseNameStatus(text);

  // AC2: a PR editing an existing migration fails.
  it.each([
    ['edited', 'M\tsupabase/migrations/20261025000100_init_schemas.sql'],
    ['deleted', 'D\tsupabase/migrations/20261025000100_init_schemas.sql'],
    [
      'renamed (delete plus add with --no-renames)',
      'D\tsupabase/migrations/20261026000100_visits.sql\nA\tsupabase/migrations/20261027000100_visits.sql',
    ],
  ])('fails when a merged migration is %s', (_, diff) => {
    expect(checkMigrations(changes(diff), base).join('\n')).toMatch(/must not be edited/);
  });

  it('fails when the base already has a migration with the same name', () => {
    const diff = 'A\tsupabase/migrations/20261026000100_visits.sql';
    expect(checkMigrations(changes(diff), base).join('\n')).toMatch(/must not be edited/);
  });

  it('passes one new migration that sorts last', () => {
    expect(checkMigrations(changes('A\tsupabase/migrations/20261027000100_eta.sql'), base)).toEqual(
      [],
    );
  });

  it('fails a new migration that sorts before the latest on base', () => {
    const problems = checkMigrations(
      changes('A\tsupabase/migrations/20261025120000_late.sql'),
      base,
    );
    expect(problems.join('\n')).toMatch(/must sort after 20261026000100_visits.sql/);
  });

  it('fails two new migrations in one PR', () => {
    const diff =
      'A\tsupabase/migrations/20261027000100_a.sql\nA\tsupabase/migrations/20261027000200_b.sql';
    expect(checkMigrations(changes(diff), base)).toEqual([
      'PR adds 2 migrations; one migration per PR.',
    ]);
  });

  it('accepts the first migration on an empty base and ignores non-SQL files', () => {
    const diff = 'A\tsupabase/migrations/20261025000100_init.sql\nM\tsupabase/migrations/README.md';
    expect(checkMigrations(changes(diff), [])).toEqual([]);
  });
});

describe('deletesDbTests', () => {
  it('flags a PR that removes any line under supabase/tests', () => {
    expect(deletesDbTests(parseNumstat('3\t1\tsupabase/tests/rls/visits.test.sql'))).toBe(true);
  });

  it('does not flag additions only, or deletions elsewhere', () => {
    expect(
      deletesDbTests(
        parseNumstat('30\t0\tsupabase/tests/rls/visits.test.sql\n0\t9\tapps/web/a.ts'),
      ),
    ).toBe(false);
  });

  it('does not flag regenerated compiled tests', () => {
    const numstat = parseNumstat('40\t12\tsupabase/tests/rls/matrix.test.sql');
    const isGenerated = (p) => p === 'supabase/tests/rls/matrix.test.sql';
    expect(deletesDbTests(numstat, { isGenerated })).toBe(false);
  });
});

describe('checkFocusedTests', () => {
  const diff = (lines) =>
    [
      'diff --git a/apps/web/src/a.test.ts b/apps/web/src/a.test.ts',
      '+++ b/apps/web/src/a.test.ts',
      '@@ -0,0 +10,9 @@',
      ...lines.map((l) => `+${l}`),
    ].join('\n');

  it.each([
    call('it', 'only'),
    call('describe', 'skip'),
    call('test', 'fixme'),
    call('test.describe', 'only'),
  ])('rejects %s without an issue link', (line) => {
    expect(checkFocusedTests(parseAddedLines(diff(['', line])))).toEqual([
      expect.objectContaining({ path: 'apps/web/src/a.test.ts', line: 11 }),
    ]);
  });

  it.each([
    `${call('it', 'skip')} // #123`,
    `${call('test', 'fixme')} // https://github.com/o/r/issues/45`,
  ])('allows %s', (line) => {
    expect(checkFocusedTests(parseAddedLines(diff([line])))).toEqual([]);
  });

  it('ignores ordinary tests and non-code files', () => {
    const md = ['+++ b/docs/testing.md', '@@ -0,0 +1 @@', `+${call('it', 'only')}`].join('\n');
    expect(checkFocusedTests(parseAddedLines(`${diff(["it('works', () => {})"])}\n${md}`))).toEqual(
      [],
    );
  });
});

describe('licence policy', () => {
  const policy = {
    allow: ['MIT', 'Apache-2.0', 'GPL-3.0-only', 'GPL-3.0-or-later'],
    exceptions: {},
  };

  it.each([
    ['MIT', true],
    ['(MIT OR SSPL-1.0)', true],
    ['(MIT AND Apache-2.0)', true],
    ['(MIT AND BUSL-1.1)', false],
    ['GPL-3.0', true],
    ['GPL-3.0+', true],
    ['SSPL-1.0', false],
    ['BUSL-1.1', false],
    ['CC-BY-NC-4.0', false],
    ['UNLICENSED', false],
    ['Unknown', false],
  ])('%s allowed: %s', (expr, expected) => {
    expect(isAllowed(expr, policy.allow)).toBe(expected);
  });

  // AC3 (the policy half): a dependency with a denied licence fails the check.
  it('reports each denied package version, honouring exceptions', () => {
    const pnpm = {
      MIT: [{ name: 'react', versions: ['19.0.0'] }],
      'BUSL-1.1': [{ name: 'some-bsl-db', versions: ['1.0.0', '1.1.0'] }],
      Unknown: [{ name: 'internal-fork', versions: ['0.1.0'] }],
    };
    expect(findViolations(pnpm, policy)).toEqual([
      'internal-fork@0.1.0 (Unknown)',
      'some-bsl-db@1.0.0 (BUSL-1.1)',
      'some-bsl-db@1.1.0 (BUSL-1.1)',
    ]);
    expect(
      findViolations(pnpm, { ...policy, exceptions: { 'internal-fork': 'ours, MIT in fact' } }),
    ).toHaveLength(2);
  });
});
