import { useSyncExternalStore } from 'react';

/** Tailwind's `sm` breakpoint: anything narrower is a phone layout. */
const PHONE = '(max-width: 639px)';

const subscribe = (notify: () => void) => {
  const mq = window.matchMedia?.(PHONE);
  mq?.addEventListener('change', notify);
  return () => mq?.removeEventListener('change', notify);
};

/** True at phone width; follows rotation and resize. False where matchMedia is unavailable. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(PHONE).matches ?? false,
    () => false,
  );
}
