import { useCallback, useEffect, useRef, useState } from 'react';

/** 45 s of no input shows the warning (WCAG 2.2.1); 20 s later the kiosk resets. */
export const IDLE_MS = 45_000;
export const WARN_MS = 20_000;
/** "I need more time" pushes the next warning this far away (WCAG 2.2.1: at least 20 s warning, extendable). */
export const EXTEND_MS = 120_000;
const TICK_MS = 250;

/**
 * A time limit with a warning and an extension. While `enabled`, any tap or key press restarts
 * the idle clock. After `idleMs` of nothing, `secondsLeft` counts down from `warnMs`; `extend`
 * (the "I need more time" button) restarts it, and at zero `onReset` runs. The clock is Date.now
 * read on a short tick, so a throttled or frozen timer cannot make the reset late by more than a tick.
 */
export function useIdleReset({
  enabled,
  onReset,
  idleMs = IDLE_MS,
  warnMs = WARN_MS,
}: {
  enabled: boolean;
  onReset: () => void;
  idleMs?: number;
  warnMs?: number;
}) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const lastInput = useRef(0);
  const warning = useRef(false);
  const reset = useRef(onReset);
  useEffect(() => {
    reset.current = onReset;
  });

  useEffect(() => {
    if (!enabled) return;
    lastInput.current = Date.now();
    // Input behind the warning dialog does not count: only "I need more time" extends.
    const touch = () => {
      if (!warning.current) lastInput.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'input'] as const;
    for (const name of events) document.addEventListener(name, touch, true);
    const timer = setInterval(() => {
      const idle = Date.now() - lastInput.current;
      if (idle >= idleMs + warnMs) {
        warning.current = false;
        setSecondsLeft(null);
        lastInput.current = Date.now();
        reset.current();
      } else if (idle >= idleMs) {
        warning.current = true;
        setSecondsLeft(Math.ceil((idleMs + warnMs - idle) / 1000));
      }
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      for (const name of events) document.removeEventListener(name, touch, true);
      warning.current = false;
    };
  }, [enabled, idleMs, warnMs]);

  const extend = useCallback(() => {
    // The warning comes back after EXTEND_MS of no input, not after the usual idle time.
    lastInput.current = Date.now() - idleMs + EXTEND_MS;
    warning.current = false;
    setSecondsLeft(null);
  }, [idleMs]);

  return { secondsLeft: enabled ? secondsLeft : null, extend };
}
