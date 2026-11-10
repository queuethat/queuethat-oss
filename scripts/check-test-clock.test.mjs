import { describe, expect, it } from 'vitest';
import { unmarkedClockUsers } from './check-test-clock.mjs';

describe('unmarkedClockUsers', () => {
  it('flags a new spec that reads the clock, not baseline or marked ones', () => {
    const specs = {
      'new.spec.ts': 'const t = Date.now() + 60_000;',
      'old.spec.ts': 'const t = new Date();',
      'marked.spec.ts': '// clock-ok: only compares two instants\nconst t = new Date();',
      'plain.spec.ts': 'await page.goto("/");',
    };
    expect(unmarkedClockUsers(specs, new Set(['old.spec.ts']))).toEqual(['new.spec.ts']);
  });
});
