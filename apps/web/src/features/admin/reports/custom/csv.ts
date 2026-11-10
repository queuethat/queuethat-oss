import { field } from '../../analytics/csv.ts';
import { DIMENSIONS, MEASURES, type ReportRow } from './api.ts';

/** The result as shown, as CSV: dimension columns then measure columns, in catalogue order. */
export function reportCsv(
  rows: ReportRow[],
  headers: Record<string, string>,
  show: (row: ReportRow, dim: (typeof DIMENSIONS)[number]) => string,
): string {
  const dims = DIMENSIONS.filter((d) => rows[0] && d in rows[0].dims);
  const measures = MEASURES.filter((m) => rows[0] && m in rows[0].measures);
  const lines = rows.map((r) =>
    [...dims.map((d) => show(r, d)), ...measures.map((m) => r.measures[m] ?? null)]
      .map(field)
      .join(','),
  );
  const head = [...dims, ...measures].map((k) => headers[k] ?? k);
  return [head.map(field).join(','), ...lines].join('\r\n') + '\r\n';
}
