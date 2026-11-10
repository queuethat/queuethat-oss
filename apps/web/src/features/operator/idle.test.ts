import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIdleLock } from './idle.ts';

describe('startIdleLock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const calls = { warn: 0, lock: 0 };
    const lock = startIdleLock({
      onWarn: () => calls.warn++,
      onLock: () => calls.lock++,
      idleMs: 600_000,
      warnMs: 20_000,
    });
    return { calls, lock };
  };

  it('warns 20 s before locking after 10 idle minutes', () => {
    const { calls } = make();
    vi.advanceTimersByTime(579_999);
    expect(calls).toEqual({ warn: 0, lock: 0 });
    vi.advanceTimersByTime(1);
    expect(calls).toEqual({ warn: 1, lock: 0 });
    vi.advanceTimersByTime(20_000);
    expect(calls).toEqual({ warn: 1, lock: 1 });
  });

  it('activity before the warning restarts the clock', () => {
    const { calls, lock } = make();
    vi.advanceTimersByTime(500_000);
    lock.touch();
    vi.advanceTimersByTime(500_000);
    expect(calls).toEqual({ warn: 0, lock: 0 });
  });

  it('a touch during the countdown does not cancel it', () => {
    const { calls, lock } = make();
    vi.advanceTimersByTime(585_000);
    lock.touch();
    vi.advanceTimersByTime(15_000);
    expect(calls.lock).toBe(1);
  });

  it('stop cancels both timers', () => {
    const { calls, lock } = make();
    lock.stop();
    vi.advanceTimersByTime(700_000);
    expect(calls).toEqual({ warn: 0, lock: 0 });
  });
});
