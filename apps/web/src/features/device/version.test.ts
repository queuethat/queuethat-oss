import { describe, expect, it } from 'vitest';
import { IDLE_MS, POLL_MS, RELOAD_COOLDOWN_MS, shouldReload } from './version.ts';

const base = {
  running: 'v1',
  served: 'v2',
  idleForMs: IDLE_MS,
  lastReloadAt: undefined,
  now: 1e12,
};

describe('shouldReload', () => {
  it('reloads an idle screen when a new version is served', () => {
    expect(shouldReload(base)).toBe(true);
  });

  it('stays put while the version matches or is not known yet', () => {
    expect(shouldReload({ ...base, served: 'v1' })).toBe(false);
    expect(shouldReload({ ...base, served: undefined })).toBe(false);
  });

  it('waits while someone is using a kiosk', () => {
    expect(shouldReload({ ...base, idleForMs: IDLE_MS - 1 })).toBe(false);
  });

  it('does not reload again within the cooldown', () => {
    expect(shouldReload({ ...base, lastReloadAt: base.now - RELOAD_COOLDOWN_MS + 1 })).toBe(false);
    expect(shouldReload({ ...base, lastReloadAt: base.now - RELOAD_COOLDOWN_MS })).toBe(true);
  });

  it('AC1: an idle screen picks up a deploy within 5 minutes', () => {
    // Worst case: the deploy lands just after a poll, so the next poll is one interval away.
    expect(POLL_MS + IDLE_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
