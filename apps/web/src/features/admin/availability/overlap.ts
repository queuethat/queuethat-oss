// Weekly availability ranges on one weekday must not overlap (A-4): two ranges for the same
// person at the same time would be ambiguous about which one rules. The check runs before
// the save so the message is clear; the database does not enforce it.

export interface Range {
  starts: string; // HH:MM
  ends: string; // HH:MM; at or before `starts` means "after midnight"
  validFrom: string | null; // YYYY-MM-DD
  validTo: string | null;
}

function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
}

/** Start and end as minutes on one weekday; a range crossing midnight ends past 1440. */
function span(r: Range): [number, number] {
  const s = minutes(r.starts);
  const e = minutes(r.ends);
  return [s, e <= s ? e + 1440 : e];
}

function datesOverlap(a: Range, b: Range): boolean {
  const aEndsBeforeB = a.validTo !== null && b.validFrom !== null && a.validTo < b.validFrom;
  const bEndsBeforeA = b.validTo !== null && a.validFrom !== null && b.validTo < a.validFrom;
  return !aEndsBeforeB && !bEndsBeforeA;
}

/** True when `candidate` shares both clock time and valid dates with any of `existing`. */
export function overlapsAny(candidate: Range, existing: readonly Range[]): boolean {
  const [cs, ce] = span(candidate);
  return existing.some((r) => {
    const [s, e] = span(r);
    return cs < e && s < ce && datesOverlap(candidate, r);
  });
}
