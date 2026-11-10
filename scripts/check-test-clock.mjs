// Keeps new e2e specs off the wall clock (see tests/e2e/support/clock.ts). A spec that reads
// `new Date()` or `Date.now()` does arithmetic around "now", which breaks near a location's
// midnight or its 04:00 service-day rollover unless the location clock is pinned. Locations are
// pinned to noon by the global setup, so such a spec is fine when it only moves minutes or hours
// from now; say so with a `// clock-ok: <why>` comment, or build times from `noonTz`.
//
// Specs that already read the clock are listed in scripts/test-clock-baseline.txt and are not
// flagged; the list may only shrink. A new spec that is not listed and has no `clock-ok` comment
// fails.
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SPEC_DIR = 'tests/e2e';
const BASELINE = 'scripts/test-clock-baseline.txt';
const CLOCK = /new Date\(\)|Date\.now\(\)/;

/** Spec files (relative names) that read the clock, have no `clock-ok` comment and are not in the baseline. */
export function unmarkedClockUsers(specs, baseline) {
  return Object.entries(specs)
    .filter(
      ([name, text]) => CLOCK.test(text) && !text.includes('clock-ok:') && !baseline.has(name),
    )
    .map(([name]) => name);
}

function main() {
  const baseline = new Set(
    readFileSync(BASELINE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
  const specs = Object.fromEntries(
    readdirSync(SPEC_DIR)
      .filter((name) => name.endsWith('.spec.ts'))
      .map((name) => [name, readFileSync(`${SPEC_DIR}/${name}`, 'utf8')]),
  );
  const bad = unmarkedClockUsers(specs, baseline);
  for (const name of bad) {
    console.error(
      `${SPEC_DIR}/${name} reads the wall clock. Add "// clock-ok: <why it is safe at any hour>" or build the times from noonTz().`,
    );
  }
  if (bad.length > 0) process.exit(1);
  console.log(`test clock: ${Object.keys(specs).length} specs checked`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
