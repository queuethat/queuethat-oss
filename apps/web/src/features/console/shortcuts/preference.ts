import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'qm.console.shortcuts';
const listeners = new Set<() => void>();
// Where storage is unavailable (private mode) the choice still holds until reload.
let memory: boolean | null = null;

function read(): boolean {
  if (memory !== null) return memory;
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Single-key shortcuts on/off for this device (WCAG 2.1.4); on by default. */
export function useShortcutsEnabled(): [boolean, (on: boolean) => void] {
  const enabled = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => true,
  );
  const set = useCallback((on: boolean) => {
    memory = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // Kept in memory above.
    }
    listeners.forEach((l) => l());
  }, []);
  return [enabled, set];
}
