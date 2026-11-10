import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_JWT_SECRET, findSecrets } from './bundle-secrets.mjs';

const jwt = (payload) =>
  [{ alg: 'HS256', typ: 'JWT' }, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .concat('signature')
    .join('.');

describe('findSecrets', () => {
  it('passes a bundle with only the anon key in it', () => {
    expect(findSecrets(`const key="${jwt({ role: 'anon' })}";`)).toEqual([]);
  });

  it('passes the key-prefix check that supabase-js ships', () => {
    expect(
      findSecrets('isNewKey=(e)=>e.startsWith(`sb_publishable_`)||e.startsWith(`sb_secret_`)'),
    ).toEqual([]);
  });

  it.each([
    ['the literal service_role', 'headers.role="service_role"', 'the string "service_role"'],
    [
      'a secret API key',
      // Assembled here so no key-shaped literal sits in the repository (secret scanners flag it).
      `k="sb_${'secret'}_${'Ab3-_'.repeat(6)}"`,
      'a secret API key (sb_secret_…)',
    ],
    ['the demo JWT secret', `s="${DEMO_JWT_SECRET}"`, 'the Supabase demo JWT secret'],
    ['a Sentry org token', 't="sntrys_eyJpYXQiOjE3MDAwMDAwMDAuMH0_abc123"', 'a Sentry auth token'],
    ['a service_role JWT', `k="${jwt({ role: 'service_role' })}"`, 'a service_role JWT'],
  ])('flags %s', (_name, text, finding) => {
    expect(findSecrets(text)).toContain(finding);
  });

  it('flags literal secrets from the build environment', () => {
    expect(findSecrets('x="my-real-jwt-secret"', [undefined, 'my-real-jwt-secret'])).toEqual([
      'a secret from the build environment',
    ]);
  });
});

describe('check-bundle-secrets.mjs', () => {
  const script = fileURLToPath(new URL('./check-bundle-secrets.mjs', import.meta.url));
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(files) {
    dir = mkdtempSync(join(tmpdir(), 'qm-dist-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  }

  // Acceptance criterion 1 (#74): given a build containing 'service_role', CI fails.
  it('exits non-zero when a built asset contains service_role', () => {
    const result = run({ 'index.html': '<html></html>', 'assets/index.js': 'r="service_role"' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assets/index.js: the string "service_role"');
  });

  it('exits zero for a clean build', () => {
    const result = run({ 'index.html': '<html></html>', 'assets/index.js': 'console.log(1)' });
    expect(result.status).toBe(0);
  });
});
