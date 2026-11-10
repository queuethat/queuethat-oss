import { StatusPill, type VisitStatus } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import type { NotAcceptingReason } from './joinErrors.ts';

type Look = 'paused' | 'closed' | 'full';

/**
 * Presentation only: which of the five state looks a refusal wears. The database decides the
 * reason (`not_accepting_reason`); this maps it to a pill and a box so Paused, Closed and Full
 * never look alike. Paused takes the attention look, Closed the quiet one, Full the stop look.
 */
const LOOK_OF: Record<NotAcceptingReason, Look> = {
  paused: 'paused',
  closed: 'closed',
  outside_hours: 'closed',
  org_suspended: 'closed',
  full: 'full',
  online_full: 'full',
};

const PILL: Record<Look, VisitStatus> = { paused: 'called', closed: 'cancelled', full: 'no_show' };

const BOX: Record<Look, string> = {
  paused: 'border-state-called-edge bg-state-called-soft text-state-called-strong',
  closed: 'border-state-cancelled-edge bg-state-cancelled-soft text-state-cancelled-strong',
  full: 'border-state-no-show-edge bg-state-no-show-soft text-state-no-show-strong',
};

/** Why joining is off: a labelled pill plus the sentence the database's reason maps to. */
export function JoinStateBanner({ reason }: { reason: NotAcceptingReason }) {
  const { t } = useTranslation('guest');
  const look = LOOK_OF[reason];
  return (
    <div
      role="status"
      data-testid="join-state"
      data-state={look}
      className={`flex flex-col items-start gap-2 rounded-card border p-4 ${BOX[look]}`}
    >
      <StatusPill status={PILL[look]}>{t(`join.state.${look}`)}</StatusPill>
      <p className="font-medium">{t(`join.notAccepting.${reason}`)}</p>
    </div>
  );
}

/** The green "Open" label above the wait while the queue takes guests. */
export function OpenPill() {
  const { t } = useTranslation('guest');
  return <StatusPill status="serving">{t('join.state.open')}</StatusPill>;
}
