// Fails when any installed dependency has a licence outside .github/license-policy.json (F4, #14).
// Works on private repos, where GitHub's dependency-review action is unavailable.
// Usage: node .github/scripts/license-check.mjs [pnpm-licenses.json]  (default: runs pnpm)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Maps deprecated SPDX ids (`GPL-3.0`, `GPL-3.0+`) to their current spelling. */
function normalize(id) {
  if (id.endsWith('+')) return `${id.slice(0, -1)}-or-later`;
  if (/^(?:A|L)?GPL-\d\.\d$/.test(id)) return `${id}-only`;
  return id;
}

/**
 * True when an SPDX expression is satisfied by the allowlist: `OR` needs one allowed side,
 * `AND` needs both. Parenthesised groups are flattened, which is exact for the expressions npm
 * packages use in practice (`(MIT OR Apache-2.0)`, `(MIT AND Zlib)`).
 */
export function isAllowed(expression, allow) {
  const allowed = new Set(allow);
  const ids = (s) =>
    s
      .replace(/[()]/g, ' ')
      .trim()
      .split(/\s+AND\s+/);
  return expression
    .split(/\s+OR\s+/)
    .some((alt) => ids(alt).every((id) => allowed.has(normalize(id))));
}

/** Lists `name@version (licence)` for every package in `pnpm licenses list --json` output that fails the policy. */
export function findViolations(pnpmLicenses, policy) {
  const violations = [];
  for (const [license, packages] of Object.entries(pnpmLicenses)) {
    for (const pkg of packages) {
      for (const version of pkg.versions) {
        const key = `${pkg.name}@${version ?? 'local'}`;
        if (policy.exceptions[key] || policy.exceptions[pkg.name]) continue;
        if (!isAllowed(license, policy.allow)) violations.push(`${key} (${license})`);
      }
    }
  }
  return violations.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const policy = JSON.parse(
    readFileSync(new URL('../license-policy.json', import.meta.url), 'utf8'),
  );
  const input = process.argv[2]
    ? readFileSync(process.argv[2], 'utf8')
    : execFileSync('pnpm', ['licenses', 'list', '--json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
  const violations = findViolations(JSON.parse(input), policy);
  for (const v of violations) {
    console.log(`::error title=Denied licence::${v} is not allowed by .github/license-policy.json`);
  }
  console.log(
    violations.length
      ? `${violations.length} denied licence(s).`
      : 'All dependency licences allowed.',
  );
  process.exit(violations.length ? 1 : 0);
}
