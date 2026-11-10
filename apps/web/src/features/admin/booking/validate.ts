import type { PolicySettings } from './api.ts';

export type PolicyErrors = Partial<Record<keyof PolicySettings, string>>;

/** Mirrors the CHECKs on app.booking_policies so a bad value is explained before the save. Keys are `booking.invalid.*`. */
export function validatePolicy(s: PolicySettings): PolicyErrors {
  const errors: PolicyErrors = {};
  const whole = (n: number | null) => n !== null && Number.isInteger(n);
  if (!whole(s.slotMinutes) || s.slotMinutes < 5) errors.slotMinutes = 'slotMinutes';
  if (
    !whole(s.slotOffsetMinutes) ||
    s.slotOffsetMinutes < 0 ||
    s.slotOffsetMinutes >= s.slotMinutes
  )
    errors.slotOffsetMinutes = 'slotOffsetMinutes';
  if (
    s.durationMinutes !== null &&
    (!whole(s.durationMinutes) || s.durationMinutes < 1 || s.durationMinutes > 600)
  )
    errors.durationMinutes = 'durationMinutes';
  if (!whole(s.bufferBeforeMinutes) || s.bufferBeforeMinutes < 0)
    errors.bufferBeforeMinutes = 'buffer';
  if (!whole(s.bufferAfterMinutes) || s.bufferAfterMinutes < 0)
    errors.bufferAfterMinutes = 'buffer';
  if (!whole(s.minNoticeMinutes) || s.minNoticeMinutes < 0)
    errors.minNoticeMinutes = 'minNoticeMinutes';
  if (!whole(s.maxDaysAhead) || s.maxDaysAhead < 1 || s.maxDaysAhead > 365)
    errors.maxDaysAhead = 'maxDaysAhead';
  return errors;
}
