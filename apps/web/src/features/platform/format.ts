import type { Tone } from '@qm/ui';
import type { OrgStatus } from './api.ts';

export const STATUS_TONE: Record<OrgStatus, Tone> = {
  active: 'success',
  suspended: 'danger',
  pending_deletion: 'warning',
};

/** A timestamp as a short local date and time, or `fallback` when there is none. */
export function formatWhen(at: string | null, locale: string, fallback: string): string {
  return at
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(at),
      )
    : fallback;
}

/** A timestamp in an IANA zone (the visit's location), with the zone name, so support reads local time. */
export function formatInZone(at: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone,
  }).format(new Date(at));
}
