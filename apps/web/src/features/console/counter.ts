import { useSyncExternalStore } from 'react';

// "My counter" (S-20) belongs to the tablet, not the person: a shared iPad at chair 2 stays at
// chair 2 whoever signs in. One choice per location, since counters belong to a location.
const key = (locationId: string) => `qm.counter:${locationId}`;
const listeners = new Set<() => void>();

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

function read(locationId: string): string | null {
  try {
    return window.localStorage.getItem(key(locationId));
  } catch {
    return null;
  }
}

/** Remembers which counter this device serves from at `locationId`. */
export function chooseCounter(locationId: string, counterId: string) {
  try {
    window.localStorage.setItem(key(locationId), counterId);
  } catch {
    // Private mode: the choice lasts until reload.
  }
  listeners.forEach((notify) => notify());
}

/**
 * This device's counter at `locationId`, if one was chosen and still exists. A counter that was
 * archived since counts as no choice, so the picker asks again.
 */
export function useMyCounter(locationId: string | undefined, counters: { id: string }[]) {
  const stored = useSyncExternalStore(
    subscribe,
    () => (locationId ? read(locationId) : null),
    () => null,
  );
  return counters.some((c) => c.id === stored) ? stored : null;
}
