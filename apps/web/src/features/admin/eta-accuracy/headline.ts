import type { EtaAccuracyRow } from './api.ts';

/** Whole-range figures: the day rows' percentages weighted by their visit counts. */
export function headline(rows: EtaAccuracyRow[]) {
  const quoted = rows.reduce((n, r) => n + r.visits, 0);
  if (quoted === 0) return null;
  const share = (pct: number | null, r: EtaAccuracyRow) => ((pct ?? 0) * r.visits) / 100;
  const within = rows.reduce((n, r) => n + share(r.withinPct, r), 0);
  const lateCount = rows.reduce((n, r) => n + share(r.latePct, r), 0);
  const lateMinutes = rows.reduce((n, r) => n + share(r.latePct, r) * (r.avgLateMin ?? 0), 0);
  return {
    withinPct: Math.round((within / quoted) * 100),
    avgLateMin: lateCount > 0 ? Math.round(lateMinutes / lateCount) : null,
  };
}
