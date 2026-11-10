import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_INBOX_MARKER, hasDevInbox } from './dev-inbox-bundle.mjs';

const script = fileURLToPath(new URL('./check-dev-inbox-bundle.mjs', import.meta.url));
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function check(content, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'app.js'), content);
  return spawnSync('node', [script, dir], {
    encoding: 'utf8',
    env: { ...process.env, VITE_DEV_INBOX: '', ...env },
  });
}

describe('dev inbox bundle check (2P-NTF11 AC1)', () => {
  it('finds the marker', () => {
    expect(hasDevInbox(`invoke("${DEV_INBOX_MARKER}")`)).toBe(true);
    expect(hasDevInbox('invoke("invite-staff")')).toBe(false);
  });

  it('passes a bundle without the route', () => {
    expect(check('console.log(1)').status).toBe(0);
  });

  it('fails a bundle with the route unless the flag is set', () => {
    const js = `fn("${DEV_INBOX_MARKER}")`;
    expect(check(js).status).toBe(1);
    expect(check(js, { VITE_DEV_INBOX: 'true' }).status).toBe(0);
  });
});
