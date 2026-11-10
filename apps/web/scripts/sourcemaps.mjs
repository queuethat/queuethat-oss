// O6 follow-up (decision 48): source maps for Sentry, never for the public. `vite build` writes
// hidden maps (no sourceMappingURL in the bundle). When the build environment has a Sentry
// token, this uploads them for the build's release; either way it then deletes every .map from
// dist/, so a deploy never serves them. Runs right after `vite build` in `pnpm build`.
//
// The token is read here, in Node at build time, and handed to sentry-cli through its own
// environment. It is never VITE_-prefixed, so Vite can't inline it, and check-bundle-secrets
// fails the build if it shows up in dist/ anyway.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Proxy and CA settings sentry-cli needs to reach Sentry from a locked-down build network.
const NETWORK_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
];
const CA_ENV = ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SENTRY_HTTP_CA_BUNDLE'];

// The comment that makes browsers (and anyone) fetch a map. Libraries may mention the word.
const LINK_COMMENT = /^\/[/*][#@] sourceMappingURL=/m;

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Runs sentry-cli with `args` and `env`, and returns its exit status. It is the exact
 * devDependency in the lockfile, so nothing is resolved fresh while the token is in the env.
 */
function runSentryCli(args, env) {
  const cli = createRequire(import.meta.url).resolve('@sentry/cli/bin/sentry-cli');
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env });
  return result.status ?? 1;
}

/**
 * Uploads dist/'s source maps to Sentry when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
 * `SENTRY_PROJECT` are all set (`SENTRY_URL` too for a self-hosted server), for the release in
 * dist/version.json (the `release` the app reports), then removes every .map file. Throws when the upload fails or a bundle still points
 * at a map; the maps are removed in both cases. Returns what it did, for the build log and tests.
 */
export function publishSourcemaps({ dist, env = process.env, run = runSentryCli }) {
  const maps = filesUnder(dist).filter((file) => file.endsWith('.map'));
  const { SENTRY_AUTH_TOKEN: token, SENTRY_ORG: org, SENTRY_PROJECT: project } = env;
  let uploaded = false;
  try {
    if (token && org && project && maps.length > 0) {
      const { version } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
      const args = ['sourcemaps', 'upload', '--org', org, '--project', project];
      args.push('--release', version, '--url-prefix', '~/', dist);
      // Only what sentry-cli needs; the token goes by environment, never on the command line.
      // SENTRY_URL points it at a self-hosted Sentry or GlitchTip; unset means sentry.io.
      const cliEnv = { PATH: env.PATH, HOME: env.HOME, SENTRY_AUTH_TOKEN: token };
      for (const key of ['SENTRY_URL', ...NETWORK_ENV, ...CA_ENV]) {
        if (env[key]) cliEnv[key] = env[key];
      }
      const status = run(args, cliEnv);
      if (status !== 0) throw new Error(`sentry-cli exited with ${status}`);
      uploaded = true;
    }
  } finally {
    for (const map of maps) rmSync(map);
  }
  const linked = filesUnder(dist).filter(
    (file) => /\.(js|css)$/.test(file) && LINK_COMMENT.test(readFileSync(file, 'utf8')),
  );
  if (linked.length > 0) {
    throw new Error(`Bundles point at source maps: ${linked.map((f) => relative(dist, f))}`);
  }
  return { maps: maps.length, uploaded };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
  const { maps, uploaded } = publishSourcemaps({ dist });
  console.log(
    `ok   ${maps} source maps ${uploaded ? 'uploaded to Sentry and ' : ''}removed from dist/`,
  );
}
