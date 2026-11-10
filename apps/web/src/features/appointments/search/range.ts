/** Date-range presets of the appointment search (A-15). All dates are the location's local `YYYY-MM-DD`. */
export type RangePreset = '30' | '90' | 'custom';

/** The inclusive local-date range a preset stands for; `custom` uses the typed dates. */
export function presetRange(
  preset: RangePreset,
  today: string,
  custom: { from: string; to: string },
): { from: string; to: string } {
  if (preset === 'custom') return custom;
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + Number(preset));
  return { from: today, to: end.toISOString().slice(0, 10) };
}

/** True when the range is something the database accepts (it refuses ranges over 366 days). */
export function validRange({ from, to }: { from: string; to: string }): boolean {
  if (!from || !to || to < from) return false;
  return (Date.parse(to) - Date.parse(from)) / 86_400_000 <= 366;
}

/** Statuses the search can narrow to. */
export const STATUS_FILTERS = [
  'booked',
  'checked_in',
  'completed',
  'no_show',
  'cancelled',
] as const;
