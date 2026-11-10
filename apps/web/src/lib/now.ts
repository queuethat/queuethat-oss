import { useEffect, useState } from 'react';

/** The current time, re-read every `ms`, for "waited 12 min"-style labels. */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
