import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdleReset } from './useIdleReset.ts';

// 2A-KSK1 (#119): 45 s idle, then a 20 s warning that "I need more time" restarts.
describe('useIdleReset', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(enabled = true) {
    const onReset = vi.fn();
    const hook = renderHook(({ on }) => useIdleReset({ enabled: on, onReset }), {
      initialProps: { on: enabled },
    });
    return { onReset, hook };
  }

  it('warns after 45 s and resets 20 s later', () => {
    const { onReset, hook } = setup();
    act(() => vi.advanceTimersByTime(44_000));
    expect(hook.result.current.secondsLeft).toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(hook.result.current.secondsLeft).toBe(19);
    expect(onReset).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(19_000));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(hook.result.current.secondsLeft).toBeNull();
  });

  it('restarts the clock on input before the warning', () => {
    const { onReset, hook } = setup();
    act(() => vi.advanceTimersByTime(40_000));
    act(() => void document.dispatchEvent(new Event('pointerdown')));
    act(() => vi.advanceTimersByTime(40_000));
    expect(hook.result.current.secondsLeft).toBeNull();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('"I need more time" restarts the timer; input behind the warning does not', () => {
    const { onReset, hook } = setup();
    act(() => vi.advanceTimersByTime(50_000));
    expect(hook.result.current.secondsLeft).not.toBeNull();
    act(() => void document.dispatchEvent(new Event('pointerdown')));
    expect(hook.result.current.secondsLeft).not.toBeNull();
    act(() => hook.result.current.extend());
    expect(hook.result.current.secondsLeft).toBeNull();
    // 2B-D5 (#262): more time means 2 minutes before the warning returns, then 20 s to the reset.
    act(() => vi.advanceTimersByTime(119_000));
    expect(hook.result.current.secondsLeft).toBeNull();
    expect(onReset).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(hook.result.current.secondsLeft).toBe(19);
    act(() => vi.advanceTimersByTime(20_000));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled', () => {
    const { onReset, hook } = setup(false);
    act(() => vi.advanceTimersByTime(120_000));
    expect(onReset).not.toHaveBeenCalled();
    expect(hook.result.current.secondsLeft).toBeNull();
  });
});
