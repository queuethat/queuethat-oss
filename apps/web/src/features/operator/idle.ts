/** Locks after `idleMs` without activity, warning `warnMs` before. */
export const IDLE_MS = 10 * 60_000;
export const WARN_MS = 20_000;

export interface IdleLock {
  /** Call on any pointer or key activity. */
  touch(): void;
  stop(): void;
}

/**
 * Walk-away protection for a shared tablet: `onWarn` fires `warnMs` before the lock and `onLock`
 * at `idleMs`. Activity (`touch`) restarts the clock. Pure timers, so tests drive it with fake time.
 */
export function startIdleLock(options: {
  onWarn: () => void;
  onLock: () => void;
  idleMs?: number;
  warnMs?: number;
}): IdleLock {
  const idleMs = options.idleMs ?? IDLE_MS;
  const warnMs = options.warnMs ?? WARN_MS;
  let warnTimer: ReturnType<typeof setTimeout>;
  let lockTimer: ReturnType<typeof setTimeout>;
  let warning = false;

  const arm = () => {
    clearTimeout(warnTimer);
    clearTimeout(lockTimer);
    warnTimer = setTimeout(() => {
      warning = true;
      options.onWarn();
    }, idleMs - warnMs);
    lockTimer = setTimeout(options.onLock, idleMs);
  };
  arm();
  return {
    touch() {
      // Once the warning shows, only the explicit "Stay" button counts, so a stray tap during the
      // countdown cannot hide it while nobody is there.
      if (warning) return;
      arm();
    },
    stop() {
      clearTimeout(warnTimer);
      clearTimeout(lockTimer);
    },
  };
}
