import { useEffect } from 'react';

/**
 * Keeps the screen on while this component is mounted, where the browser supports the Screen
 * Wake Lock API. Browsers drop the lock when the tab is hidden, so it is taken again whenever
 * the page becomes visible. Unsupported or refused: the TV's own sleep settings apply.
 */
export function useWakeLock() {
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let released = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      wakeLock.request('screen').then(
        (lock) => {
          if (released) void lock.release();
          else sentinel = lock;
        },
        () => {},
      );
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release();
    };
  }, []);
}
