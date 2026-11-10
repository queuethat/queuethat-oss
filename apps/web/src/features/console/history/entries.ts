import type { VisitHistoryEntry } from '../api.ts';

export interface TimelineEntry extends VisitHistoryEntry {
  /** Who undid this entry, when it was undone and the undo is in the list. */
  undoneBy: string | null;
}

/**
 * Pairs each undone entry with the undo that reversed it. Undo only ever reverses the latest
 * action, so an `undo` row claims the nearest earlier unclaimed entry of the type it undoes.
 * Display only: the database owns which actions are undone (`summary.undone`).
 */
export function timeline(history: VisitHistoryEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = history.map((e) => ({ ...e, undoneBy: null }));
  out.forEach((undo, index) => {
    if (undo.type !== 'undo') return;
    const undoes = undo.summary.undoes_type;
    for (let i = index - 1; i >= 0; i--) {
      const target = out[i]!;
      if (target.summary.undone === true && target.undoneBy === null && target.type === undoes) {
        target.undoneBy = undo.actor;
        break;
      }
    }
  });
  return out;
}
