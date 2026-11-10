/** Returns a copy of `list` with the item at `from` moved to index `to` (clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, item as T);
  return next;
}

/** Insertion slot for a pointer at `y`: rows whose midpoint is above it (the final index). */
export function slotAtPoint(
  rows: ReadonlyArray<{ top: number; height: number }>,
  y: number,
): number {
  return rows.filter((r) => r.top + r.height / 2 < y).length;
}
