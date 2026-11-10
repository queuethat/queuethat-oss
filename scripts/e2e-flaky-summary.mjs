#!/usr/bin/env node
// Reads Playwright's JSON report and writes the tests that needed their retry ("flaky") and the
// ones that failed every attempt to the GitHub run summary. Used by the `e2e` job in
// .github/workflows/ci.yml, the only place browser tests get a retry.
//
//   node scripts/e2e-flaky-summary.mjs [report.json] [title]
//
// Prints the markdown to stdout, appends it to $GITHUB_STEP_SUMMARY when set, and sets the step
// output `failed_attempt` to true when any test failed at least once, so the job can keep the
// stack's logs for a retried test too. Always exits 0: the Playwright step decides pass or fail.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [file = 'test-results/results.json', title = 'Browser tests'] = process.argv.slice(2);

/** Every test in the report as { name, status }, status being Playwright's per-test outcome. */
export function outcomes(report) {
  const found = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        found.push({
          name: `[${test.projectName}] ${spec.file}:${spec.line} › ${spec.title}`,
          status: test.status,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return found;
}

export function summarize(report, heading) {
  const all = outcomes(report);
  const flaky = all.filter((t) => t.status === 'flaky');
  const failed = all.filter((t) => t.status === 'unexpected');
  const lines = [`### ${heading}`, ''];
  if (flaky.length === 0 && failed.length === 0) {
    lines.push('No test failed an attempt.');
  }
  if (flaky.length > 0) {
    lines.push(
      `**${flaky.length} flaky** (failed, then passed on the one retry). The run is not failed for these, but each is a bug to fix if it keeps appearing here:`,
      '',
      ...flaky.map((t) => `- ${t.name}`),
      '',
    );
  }
  if (failed.length > 0) {
    lines.push(
      `**${failed.length} failed** (both attempts):`,
      '',
      ...failed.map((t) => `- ${t.name}`),
    );
  }
  return { markdown: lines.join('\n') + '\n', failedAttempt: flaky.length + failed.length > 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let result;
  if (existsSync(file)) {
    result = summarize(JSON.parse(readFileSync(file, 'utf8')), title);
  } else {
    // Playwright stopped before it could report (the stack or the web server did not start).
    result = {
      markdown: `### ${title}\n\nNo Playwright report at \`${file}\`: the run stopped before any result was written.\n`,
      failedAttempt: true,
    };
  }
  process.stdout.write(result.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `failed_attempt=${result.failedAttempt}\n`);
  }
}
