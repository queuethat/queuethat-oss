import type { AnalyticsRow } from './api.ts';

export const field = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The table as shown, as CSV: one header row and one row per bucket; rates are fractions. */
export function toCsv(headers: string[], rows: AnalyticsRow[]): string {
  const lines = rows.map((r) =>
    [r.label, r.joined, r.served, r.p50WaitMin, r.p90WaitMin, r.abandonment, r.noShow]
      .map(field)
      .join(','),
  );
  return [headers.map(field).join(','), ...lines].join('\r\n') + '\r\n';
}

/** Local YYYY-MM-DD, `daysAgo` days before today. */
export function isoDay(daysAgo = 0, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Total joins per hour of the day, from hour buckets labelled `YYYY-MM-DD HH:00`. */
export function joinsByHour(rows: AnalyticsRow[]): number[] {
  const hours = Array<number>(24).fill(0);
  for (const r of rows) hours[Number(r.label.slice(11, 13))]! += r.joined;
  return hours;
}
