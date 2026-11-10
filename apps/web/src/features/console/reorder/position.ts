/**
 * The `p_after_visit_id` for putting `id` at `toIndex` of `ids` (null = to the front), where
 * `toIndex` counts the list as it will be after the move. Null also when nothing would change,
 * so callers can skip the call.
 */
export function afterIdForMove(
  ids: readonly string[],
  id: string,
  toIndex: number,
): { afterId: string | null } | null {
  const from = ids.indexOf(id);
  if (from < 0 || toIndex < 0 || toIndex >= ids.length || toIndex === from) return null;
  const rest = ids.filter((x) => x !== id);
  return { afterId: toIndex === 0 ? null : (rest[toIndex - 1] ?? null) };
}
