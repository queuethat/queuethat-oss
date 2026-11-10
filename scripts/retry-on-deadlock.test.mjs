import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = new URL('./retry-on-deadlock.sh', import.meta.url).pathname;

/** A command that fails `failures` times with `message`, then succeeds; counts its runs. */
function flaky(failures, message) {
  const dir = mkdtempSync(join(tmpdir(), 'retry-'));
  const counter = join(dir, 'runs');
  const command = join(dir, 'command.sh');
  writeFileSync(counter, '0');
  writeFileSync(
    command,
    `n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
if [ "$n" -le ${failures} ]; then echo "${message}"; exit 7; fi
echo applied`,
  );
  return { command, runs: () => Number(readFileSync(counter, 'utf8')) };
}

const run = (command) => spawnSync('bash', [script, 'sh', command], { encoding: 'utf8' });

describe('retry-on-deadlock.sh', () => {
  it('runs a command that succeeds once', () => {
    const c = flaky(0, '');
    expect(execFileSync('bash', [script, 'sh', c.command], { encoding: 'utf8' })).toContain(
      'applied',
    );
    expect(c.runs()).toBe(1);
  });

  it('runs it again after a deadlock and succeeds', () => {
    const c = flaky(2, 'ERROR: deadlock detected (SQLSTATE 40P01)');
    const result = run(c.command);
    expect(result.status).toBe(0);
    expect(c.runs()).toBe(3);
    expect(result.stderr).toContain('attempt 1 of 3');
  });

  it('gives up after three deadlocks with the command’s own status', () => {
    const c = flaky(5, 'ERROR: deadlock detected (SQLSTATE 40P01)');
    expect(run(c.command).status).toBe(7);
    expect(c.runs()).toBe(3);
  });

  it('does not retry any other failure', () => {
    const c = flaky(1, 'ERROR: syntax error at or near "tabel" (SQLSTATE 42601)');
    expect(run(c.command).status).toBe(7);
    expect(c.runs()).toBe(1);
  });
});
