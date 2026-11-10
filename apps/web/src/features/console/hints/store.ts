import { useCallback, useSyncExternalStore } from 'react';

/** The three first-open hints, in the order they are shown. */
export const HINTS = ['callNext', 'undo', 'shortcuts'] as const;
export type Hint = (typeof HINTS)[number];

const KEY = 'qm.console.hints';
const listeners = new Set<() => void>();
// Where storage is unavailable (private mode) a dismissal still holds until reload.
let memory: readonly Hint[] | null = null;

function read(): readonly Hint[] {
  if (memory) return memory;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(raw)) return HINTS.filter((h) => raw.includes(h));
  } catch {
    // Fall through: nothing dismissed.
  }
  return [];
}

// useSyncExternalStore needs a stable snapshot between changes.
let snapshot: readonly Hint[] | null = null;
function getSnapshot(): readonly Hint[] {
  const next = read();
  if (snapshot && snapshot.length === next.length && snapshot.every((h, i) => h === next[i])) {
    return snapshot;
  }
  snapshot = next;
  return next;
}

/**
 * Which console hints this browser has dismissed, and a way to dismiss more. Kept per browser,
 * not per person, so on a shared tablet the next operator does not see them again.
 */
export function useDismissedHints(): [readonly Hint[], (hints: readonly Hint[]) => void] {
  const dismissed = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot,
    () => [],
  );
  const dismiss = useCallback((hints: readonly Hint[]) => {
    memory = HINTS.filter((h) => read().includes(h) || hints.includes(h));
    try {
      localStorage.setItem(KEY, JSON.stringify(memory));
    } catch {
      // Kept in memory above.
    }
    listeners.forEach((l) => l());
  }, []);
  return [dismissed, dismiss];
}

/** Test helper: forget in-memory state. */
export function resetHintsForTest() {
  memory = null;
  snapshot = null;
}
