// Runs the PR checks from pr-checks-lib.mjs against a checked-out PR (F4, #14).
// Env: BASE_SHA (base branch tip), HEAD_SHA, PR_TITLE, PR_LABELS (JSON array of names).
// Exits 1 when any check fails; writes needs_human=true to GITHUB_OUTPUT when the PR deletes
// lines under supabase/tests.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  MIGRATIONS_DIR,
  checkFocusedTests,
  checkMigrations,
  checkSize,
  checkTitle,
  deletesDbTests,
  parseAddedLines,
  parseNameStatus,
  parseNumstat,
} from './pr-checks-lib.mjs';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const { BASE_SHA, HEAD_SHA = 'HEAD', PR_TITLE = '', PR_LABELS = '[]' } = process.env;
if (!BASE_SHA) throw new Error('BASE_SHA is required');
const range = `${BASE_SHA}...${HEAD_SHA}`;
const labels = JSON.parse(PR_LABELS);

const numstat = parseNumstat(git('diff', '--numstat', '--no-renames', range));
const changes = parseNameStatus(git('diff', '--name-status', '--no-renames', range));
const addedLines = parseAddedLines(git('diff', '-U0', '--no-renames', '--no-color', range));
const baseMigrations = git('ls-tree', '--name-only', BASE_SHA, MIGRATIONS_DIR)
  .split('\n')
  .filter((p) => p.endsWith('.sql'))
  .map((p) => p.slice(MIGRATIONS_DIR.length));

const generated = new Set(
  numstat.length === 0
    ? []
    : git('check-attr', 'linguist-generated', '--', ...numstat.map((f) => f.path))
        .split('\n')
        .filter((l) => l.endsWith(': linguist-generated: true'))
        .map((l) => l.slice(0, -': linguist-generated: true'.length)),
);

const size = checkSize(numstat, { isGenerated: (p) => generated.has(p), labels });
const results = [
  // Empty only in local runs (ci-local.sh) that don't pass a title.
  ['Semantic title', PR_TITLE ? checkTitle(PR_TITLE) : []],
  ['Migrations', checkMigrations(changes, baseMigrations)],
];

let failed = false;
for (const [name, problems] of results) {
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}`);
  for (const p of problems) console.log(`::error title=${name}::${p}`);
  failed ||= problems.length > 0;
}

// Advisory only: never fails the job.
console.log(`${size.warnings.length ? 'WARN' : 'ok  '} Size (${size.total} counted lines)`);
for (const w of size.warnings) console.log(`::warning title=PR size::${w}`);

const focused = checkFocusedTests(addedLines);
console.log(`${focused.length ? 'FAIL' : 'ok  '} Skipped or focused tests`);
for (const f of focused)
  console.log(`::error file=${f.path},line=${f.line},title=Skipped test::${f.message}`);
failed ||= focused.length > 0;

const needsHuman = deletesDbTests(numstat, { isGenerated: (p) => generated.has(p) });
console.log(`${needsHuman ? 'FLAG' : 'ok  '} Deletes lines under supabase/tests`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `needs_human=${needsHuman}\n`);

process.exit(failed ? 1 : 0);
