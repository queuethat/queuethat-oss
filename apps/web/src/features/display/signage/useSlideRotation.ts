import { useEffect, useState } from 'react';

/**
 * The index of the slide to show: each stays `durations[i]` seconds, then the next, wrapping.
 * While `paused` (a call is on screen) the clock stops and the slide that was up stays chosen;
 * when the pause ends it gets its full time again. Fewer slides than the index (the list shrank)
 * start over from the first.
 */
export function useSlideRotation(durations: readonly number[], paused: boolean): number {
  const [index, setIndex] = useState(0);
  const count = durations.length;
  const current = count === 0 ? 0 : index >= count ? 0 : index;
  const seconds = durations[current];
  useEffect(() => {
    if (paused || count < 2 || seconds === undefined) return;
    const timer = setTimeout(() => setIndex((current + 1) % count), seconds * 1_000);
    return () => clearTimeout(timer);
  }, [paused, count, seconds, current]);
  return current;
}
