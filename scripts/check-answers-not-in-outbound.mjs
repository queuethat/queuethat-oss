// C6 (#1272): the code half of "form answers never reach outbound content or logs" (I-5, I-11, I-13).
// The database half is supabase/tests/compliance/answers_not_outbound.test.sql, which seeds answers,
// drives every notification, webhook and export path, and searches every table and claim payload.
//
// This script covers what pgTAP cannot see, the Edge Functions that send, log and export:
//  1. Only the files in READERS may mention an answer store or answers at all. public-join passes
//     the guest's answers straight to api.join_queue; nothing else has a reason to handle them, so a
//     new mention fails until someone has checked where its output goes and listed the file here.
//  2. A READERS file never puts answers on a log, error or console line.
//  3. export-data never lists an answer store in TABLES (the org export is a zip of whole tables).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FUNCTIONS_DIR = 'supabase/functions';
/** Edge Function sources that may handle answers, and why. */
export const READERS = new Map([
  [
    'public-join/handler.ts',
    'validates the request shape, then hands p_answers to api.join_queue; logs only the failure',
  ],
]);
const ANSWER_WORDS =
  /\b(visit_answers|form_responses|form_answers|intake_fields|validate_answers|p_answers|answers)\b/;
const LOG_CALL = /\b(logInfo|logError|console\.\w+|error|observe\.\w+|log)\s*\(/;

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Problems found in Edge Function sources: `files` maps a path under supabase/functions (no tests) to
 * its text, `exportTables` is the table names export-data lists.
 */
export function findProblems(files, exportTables, readers = READERS) {
  const problems = [];
  for (const [name, text] of Object.entries(files)) {
    const code = stripComments(text);
    if (!ANSWER_WORDS.test(code)) continue;
    if (!readers.has(name)) {
      problems.push(
        `${name}: handles intake answers but is not listed in READERS (scripts/check-answers-not-in-outbound.mjs)`,
      );
      continue;
    }
    for (const line of code.split('\n')) {
      if (LOG_CALL.test(line) && ANSWER_WORDS.test(line)) {
        problems.push(`${name}: puts answers on a log or error line: ${line.trim()}`);
      }
    }
  }
  for (const table of exportTables) {
    if (ANSWER_WORDS.test(table))
      problems.push(`export-data/handler.ts: TABLES lists the answer store ${table}`);
  }
  return problems;
}

function sources(dir, base = dir) {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, sources(path, base));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out[path.slice(base.length + 1)] = readFileSync(path, 'utf8');
    }
  }
  return out;
}

function main() {
  const exportText = readFileSync(`${FUNCTIONS_DIR}/export-data/handler.ts`, 'utf8');
  const block = exportText.match(/export const TABLES[\s\S]*?\n\];/);
  const tables = block ? [...block[0].matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]) : [];
  if (tables.length === 0) {
    console.error(
      'check-answers-not-in-outbound: could not read TABLES from export-data/handler.ts',
    );
    process.exit(1);
  }
  const problems = findProblems(sources(FUNCTIONS_DIR), tables);
  for (const problem of problems) console.error(`check-answers-not-in-outbound: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `check-answers-not-in-outbound: ok (${tables.length} exported tables, ${READERS.size} allowed reader)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
