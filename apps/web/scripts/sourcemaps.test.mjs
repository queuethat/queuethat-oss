import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishSourcemaps } from './sourcemaps.mjs';

const SENTRY = { SENTRY_AUTH_TOKEN: 'sntrys_test', SENTRY_ORG: 'qm', SENTRY_PROJECT: 'web' };

describe('publishSourcemaps', () => {
  let dist;
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'qm-maps-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'version.json'), '{"version":"20261025140000"}');
    writeFileSync(join(dist, 'assets/index-abc.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets/index-abc.js.map'), '{"version":3}');
    writeFileSync(join(dist, 'sw.js.map'), '{"version":3}');
  });
  afterEach(() => rmSync(dist, { recursive: true, force: true }));

  const calls = [];
  const fakeCli = (status) => (args, env) => {
    calls.push({ args, env });
    return status;
  };
  afterEach(() => (calls.length = 0));

  it('without a Sentry token, uploads nothing and removes every map', () => {
    expect(publishSourcemaps({ dist, env: {}, run: fakeCli(0) })).toEqual({
      maps: 2,
      uploaded: false,
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(dist, 'assets/index-abc.js.map'))).toBe(false);
    expect(existsSync(join(dist, 'sw.js.map'))).toBe(false);
    expect(existsSync(join(dist, 'assets/index-abc.js'))).toBe(true);
  });

  it('with a token, uploads for the build release, passes the token only by environment, then removes the maps', () => {
    const env = { ...SENTRY, PATH: '/bin', HOME: '/home/ci', VITE_SUPABASE_URL: 'x' };
    expect(publishSourcemaps({ dist, env, run: fakeCli(0) })).toEqual({ maps: 2, uploaded: true });
    expect(calls).toHaveLength(1);
    const [{ args, env: cliEnv }] = calls;
    expect(args).toEqual([
      'sourcemaps',
      'upload',
      '--org',
      'qm',
      '--project',
      'web',
      '--release',
      '20261025140000',
      '--url-prefix',
      '~/',
      dist,
    ]);
    expect(args.join(' ')).not.toContain('sntrys_test');
    expect(cliEnv).toEqual({ PATH: '/bin', HOME: '/home/ci', SENTRY_AUTH_TOKEN: 'sntrys_test' });
    expect(existsSync(join(dist, 'assets/index-abc.js.map'))).toBe(false);
  });

  it('points the CLI at a self-hosted server when SENTRY_URL is set', () => {
    publishSourcemaps({
      dist,
      env: { ...SENTRY, SENTRY_URL: 'https://glitchtip.example' },
      run: fakeCli(0),
    });
    expect(calls[0].env.SENTRY_URL).toBe('https://glitchtip.example');
  });

  it('passes proxy and CA settings so uploads work behind a build proxy', () => {
    const network = {
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      SSL_CERT_FILE: '/ca.crt',
    };
    publishSourcemaps({ dist, env: { ...SENTRY, ...network, AWS_SECRET: 'x' }, run: fakeCli(0) });
    expect(calls[0].env).toMatchObject(network);
    expect(calls[0].env.AWS_SECRET).toBeUndefined();
  });

  it('fails the build when the upload fails, and still removes the maps', () => {
    expect(() => publishSourcemaps({ dist, env: SENTRY, run: fakeCli(1) })).toThrow(
      'exited with 1',
    );
    expect(existsSync(join(dist, 'assets/index-abc.js.map'))).toBe(false);
    expect(existsSync(join(dist, 'sw.js.map'))).toBe(false);
  });

  it('fails the build when a bundle still links a map', () => {
    writeFileSync(
      join(dist, 'assets/index-abc.js'),
      'console.log(1)\n//# sourceMappingURL=index-abc.js.map',
    );
    expect(() => publishSourcemaps({ dist, env: {}, run: fakeCli(0) })).toThrow(
      'Bundles point at source maps: assets/index-abc.js',
    );
  });

  it('ignores a library that only mentions the word', () => {
    writeFileSync(join(dist, 'assets/index-abc.js'), 'const re=/sourceMappingURL=(.*)/;');
    expect(publishSourcemaps({ dist, env: {}, run: fakeCli(0) }).maps).toBe(2);
  });
});
