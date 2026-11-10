// Pure rules behind the PR checks (F4, #14). pr-checks.mjs feeds them git output; tests feed
// them fixtures. Each check returns a list of problems; an empty list means it passed.

export const SIZE_LIMIT = 400;
export const SIZE_OVERRIDE_LABEL = 'size:override';
export const MIGRATIONS_DIR = 'supabase/migrations/';
export const DB_TESTS_DIR = 'supabase/tests/';

const TITLE_TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'test',
  'docs',
  'build',
  'ci',
  'chore',
  'revert',
];
const TITLE_RE = new RegExp(
  `^(?:${TITLE_TYPES.join('|')})\\([a-z0-9-]+(?:,[a-z0-9-]+)*\\)!?: \\S.*?(?: \\[[A-Z]{1,2}-\\d+(?:, ?[A-Z]{1,2}-\\d+)*\\])?$`,
);

/**
 * PR titles follow `type(area): summary [FEATURE-IDS]`; the feature-ID suffix is optional
 * because chores and infra tickets often have none.
 */
export function checkTitle(title) {
  if (TITLE_RE.test(title.trim())) return [];
  return [
    `PR title "${title}" must look like "type(area): summary [X-1, J-2]" with type one of ${TITLE_TYPES.join(', ')}.`,
  ];
}

/** Parses `git diff --numstat` output. Binary files count as zero lines. */
export function parseNumstat(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
}

/** Parses `git diff --name-status --no-renames` output into `{ status, path }`. */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status: status[0], path };
    });
}

/** Translations are reviewed separately and would otherwise dominate the count. */
export function isLocaleFile(path) {
  return /(^|\/)locales\//.test(path);
}

/**
 * Counts added plus deleted lines, skipping files `isGenerated` reports (the
 * `linguist-generated` attribute in .gitattributes, which covers the lockfile and generated
 * types) and locale files. Advisory since the maintainer's merge policy of 2026-10-25: over the limit is a
 * warning, never a failure. `size:override` silences the warning.
 */
export function checkSize(numstat, { isGenerated, labels }) {
  const counted = numstat.filter((f) => !isGenerated(f.path) && !isLocaleFile(f.path));
  const total = counted.reduce((sum, f) => sum + f.added + f.deleted, 0);
  if (total <= SIZE_LIMIT) return { total, warnings: [] };
  if (labels.includes(SIZE_OVERRIDE_LABEL)) return { total, warnings: [] };
  return {
    total,
    warnings: [
      `PR changes ${total} lines (guideline ${SIZE_LIMIT}, excluding generated and locale files). Consider splitting it.`,
    ],
  };
}

const isMigration = (path) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql');
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Merged migrations are immutable, and a new migration must sort after every migration on the
 * base branch so it applies last everywhere. One migration per PR (technical-design.md 11.2).
 *
 * `changes` is the name-status diff from the merge base; `baseMigrations` lists the migration
 * file names on the current base tip, which may be ahead of the merge base.
 */
export function checkMigrations(changes, baseMigrations) {
  const problems = [];
  const onBase = new Set(baseMigrations);
  const migrations = changes.filter((c) => isMigration(c.path));
  const added = migrations.filter((c) => c.status === 'A' && !onBase.has(basename(c.path)));

  for (const c of migrations) {
    if (!added.includes(c)) {
      problems.push(
        `${c.path}: merged migrations must not be edited, renamed or deleted. Add a new migration.`,
      );
    }
  }
  const latest = [...baseMigrations].sort().at(-1);
  for (const c of added) {
    if (latest && basename(c.path) <= latest) {
      problems.push(
        `${c.path}: new migration must sort after ${latest}. Rename it with a later timestamp.`,
      );
    }
  }
  if (added.length > 1) {
    problems.push(`PR adds ${added.length} migrations; one migration per PR.`);
  }
  return problems;
}

/**
 * True when the PR removes any hand-written line under supabase/tests, which needs a human to
 * look. Compiled tests are skipped: their source (matrix.yaml) sits in the same folder.
 */
export function deletesDbTests(numstat, { isGenerated = () => false } = {}) {
  return numstat.some(
    (f) => f.path.startsWith(DB_TESTS_DIR) && f.deleted > 0 && !isGenerated(f.path),
  );
}

/** Parses `git diff -U0` into the added lines with their new line numbers. */
export function parseAddedLines(diff) {
  const lines = [];
  let path = null;
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw === '+++ /dev/null' ? null : raw.slice('+++ b/'.length);
    } else if (raw.startsWith('@@')) {
      lineNo = Number(/\+(\d+)/.exec(raw)[1]);
    } else if (raw.startsWith('+') && path) {
      lines.push({ path, line: lineNo, text: raw.slice(1) });
      lineNo += 1;
    }
  }
  return lines;
}

const FOCUS_RE = /\b(?:describe|it|test|suite)(?:\.\w+)*\.(?:skip|only|fixme)\b/;
const ISSUE_LINK_RE = /#\d+|\/issues\/\d+/;
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

/** A skipped, focused or fixme test is allowed only with an issue link on the same line. */
export function checkFocusedTests(addedLines) {
  return addedLines
    .filter(
      (l) => CODE_FILE_RE.test(l.path) && FOCUS_RE.test(l.text) && !ISSUE_LINK_RE.test(l.text),
    )
    .map((l) => ({
      path: l.path,
      line: l.line,
      message:
        'Skipped, focused or fixme test without an issue link. Add "// #123" on the same line, or remove it.',
    }));
}
