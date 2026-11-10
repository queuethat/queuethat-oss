import type { Database } from '@qm/db-types';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { iconAlertTriangle, iconClock, iconUser, iconX, type IconDef } from './icons.ts';

/** Visit states, owned by the database (technical-design.md 4.1). */
export type VisitStatus = Database['api']['Enums']['visit_state'];

type QueueState = 'waiting' | 'called' | 'serving' | 'no-show' | 'cancelled';

const iconMinus: IconDef = 'M6 12h12';

/**
 * The only place a visit state gets its colours and icon. Colours come from the `state-*` tokens
 * in theme.css. Called is the state a guest must not miss: a thicker edge and a triangle icon, so
 * it reads without colour as well as with it.
 */
const look: Record<QueueState, { box: string; icon: IconDef }> = {
  waiting: {
    box: 'border bg-state-waiting-soft text-state-waiting-strong border-state-waiting-edge',
    icon: iconClock,
  },
  called: {
    box: 'border-2 bg-state-called-soft text-state-called-strong border-state-called-edge',
    icon: iconAlertTriangle,
  },
  serving: {
    box: 'border bg-state-serving-soft text-state-serving-strong border-state-serving-edge',
    icon: iconUser,
  },
  'no-show': {
    box: 'border bg-state-no-show-soft text-state-no-show-strong border-state-no-show-edge',
    icon: iconX,
  },
  cancelled: {
    box: 'border bg-state-cancelled-soft text-state-cancelled-strong border-state-cancelled-edge',
    icon: iconMinus,
  },
};

/** Maps the database's visit status to one of five looks. Presentation only; the DB owns the state machine. */
const lookOf: Record<VisitStatus, QueueState> = {
  expected: 'cancelled',
  waiting: 'waiting',
  called: 'called',
  serving: 'serving',
  served: 'serving',
  no_show: 'no-show',
  cancelled: 'cancelled',
  removed: 'no-show',
  expired: 'cancelled',
};

export interface StatusPillProps {
  status: VisitStatus;
  /** The label, already through t(). Colour is never the only signal: an icon shape plus this text. */
  children: ReactNode;
}

/** One look per visit status: icon, label, and an edge that reads without colour. */
export function StatusPill({ status, children }: StatusPillProps) {
  const l = look[lookOf[status]];
  return (
    <span
      data-status={status}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold',
        l.box,
      )}
    >
      <Icon icon={l.icon} size="sm" />
      {children}
    </span>
  );
}
