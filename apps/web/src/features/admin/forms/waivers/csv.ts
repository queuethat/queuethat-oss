import { localDateTimeValue } from '@qm/domain';
import type { WaiverExport } from './api.ts';

/**
 * A CSV cell. Names are typed by guests, so a cell that a spreadsheet would read as a formula
 * (leading = + - @ or a control character) gets a quote in front and shows as text.
 */
export const cell = (v: string | number | null): string => {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The shown local time, `2026-11-09 10:42`, in the location's time zone. */
export const localStamp = (iso: string, timeZone: string): string =>
  localDateTimeValue(iso, timeZone).replace('T', ' ');

/** The export as CSV: the header row passed in (already translated), then one row per record. */
export function waiversToCsv(headers: string[], data: WaiverExport): string {
  const lines = data.rows.map((r) =>
    [
      localStamp(r.acceptedAt, data.timezone),
      r.form,
      r.version,
      r.agreement,
      r.guestName,
      r.typedName,
      r.guardianName,
      r.signedAt ? localStamp(r.signedAt, data.timezone) : null,
      r.subject,
      r.textHash,
    ]
      .map(cell)
      .join(','),
  );
  return [headers.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
}

/** Hands the text to the browser as a file download. */
export function downloadCsv(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
