import { expect } from '@playwright/test';

/**
 * How long a change made on one device may take to show on another (realtime, then the
 * polling fallback in `useLiveQuery`).
 */
export const LIVE_TIMEOUT_MS = 10_000;

/**
 * `expect.poll` with the intervals and timeout used for cross-device checks. Use it instead
 * of sleeping: `await eventually(() => display.getByTestId('now-serving').textContent()).toBe('A12')`.
 */
export function eventually<T>(read: () => T | Promise<T>, message?: string) {
  return expect.poll(read, {
    message,
    intervals: [100, 250, 500, 1_000],
    timeout: LIVE_TIMEOUT_MS,
  });
}
