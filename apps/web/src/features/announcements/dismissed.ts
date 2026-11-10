import { useCallback, useState } from 'react';

/** localStorage key for the info announcements one user has dismissed on this browser. */
export function dismissedKey(userId: string): string {
  return `qm.announcements.dismissed.${userId}`;
}

/** The dismissed ids, or none when storage is empty, unreadable or blocked. */
export function readDismissed(userId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(dismissedKey(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Remembers `id` as dismissed. Ids no longer in `activeIds` are dropped, so the list never
 * outgrows the announcements that are up. A blocked storage only loses the memory.
 */
export function writeDismissed(userId: string, id: string, activeIds: readonly string[]): string[] {
  const next = [...readDismissed(userId).filter((d) => activeIds.includes(d) && d !== id), id];
  try {
    window.localStorage.setItem(dismissedKey(userId), JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the dismissal still holds until the page reloads.
  }
  return next;
}

/** The ids `userId` has dismissed, and a function that dismisses one more. Key the caller by user. */
export function useDismissedAnnouncements(userId: string) {
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const dismiss = useCallback(
    (id: string, activeIds: readonly string[]) =>
      setDismissed(writeDismissed(userId, id, activeIds)),
    [userId],
  );
  return { dismissed, dismiss };
}
