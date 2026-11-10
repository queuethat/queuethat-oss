import { StatusPill, type VisitStatus } from '@qm/ui';
import type { ReactNode } from 'react';

/**
 * Presentation only: which of the five state looks an appointment or waitlist status wears, so
 * the token pages (`/a`, `/o`) show the same pills as the queue. The database owns the status;
 * a held time, an open offer and a payment waiting need the guest, so they take the attention look.
 */
const LOOK: Record<string, VisitStatus> = {
  booked: 'waiting',
  waiting: 'waiting',
  offered: 'called',
  pending_payment: 'called',
  claimed: 'serving',
  completed: 'serving',
  no_show: 'no_show',
  cancelled: 'cancelled',
  expired: 'expired',
};

/** A status pill for an appointment or waitlist entry. `children` is the label, through t(). */
export function BookingStatusPill({ status, children }: { status: string; children: ReactNode }) {
  return <StatusPill status={LOOK[status] ?? 'waiting'}>{children}</StatusPill>;
}
