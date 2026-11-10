import { Badge, Button, Card, ConfirmDestructive } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { OfflineAction } from '../../../lib/offline-queue.ts';
import type { ConsoleVisit } from '../api.ts';
import { offlineQueue, replayOffline, useOfflineActions, useOnline } from './queue.ts';

/**
 * S-12 (#275): how many actions wait, and the ones the database refused, for a person to decide.
 * Nothing is applied again until they choose: "Apply again" uses a fresh key and the visit's
 * current version, "Discard" drops it.
 */
export function OfflinePanel({ visits }: { visits: ConsoleVisit[] }) {
  const { t } = useTranslation('staff');
  const online = useOnline();
  const { actions } = useOfflineActions();
  const waiting = actions.filter((a) => a.status === 'pending');
  const conflicts = actions.filter((a) => a.status === 'conflict');
  return (
    <>
      {waiting.length > 0 ? (
        <Card role="status" className="mb-4 bg-warning-soft text-warning-strong">
          {t(online ? 'console.offline.sending' : 'console.offline.waiting', {
            count: waiting.length,
          })}
        </Card>
      ) : null}
      {conflicts.length > 0 ? (
        <Card
          role="region"
          aria-labelledby="offline-review"
          className="mb-4 flex flex-col gap-3"
          data-testid="offline-review"
        >
          <h2 id="offline-review" className="text-lg font-semibold">
            {t('console.offline.review.title', { count: conflicts.length })}
          </h2>
          <ul className="flex flex-col gap-3">
            {conflicts.map((a) => (
              <Conflict key={a.id} action={a} visit={visits.find((v) => v.id === a.visitId)} />
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function Conflict({ action, visit }: { action: OfflineAction; visit?: ConsoleVisit }) {
  const { t } = useTranslation('staff');
  const who = action.label.ticket ?? action.label.name ?? t('console.offline.guest');
  // A walk-in that was refused has no visit to compare with; a visit that left the active list
  // (finished, removed) can't take the action again.
  const canRetry = action.rpc === 'staff_add_visit' || !!visit;
  const again = async () => {
    await offlineQueue().retry(action.id, {
      ...action.args,
      p_idempotency_key: crypto.randomUUID(),
      ...(visit ? { p_expected_version: visit.version } : {}),
    });
    await replayOffline();
  };
  return (
    <li className="flex flex-wrap items-center gap-3" data-testid="offline-conflict">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {t('console.offline.review.what', {
            ticket: who,
            action: t(`console.offline.actionName.${action.label.action}`, {
              defaultValue: action.label.action,
            }),
          })}
        </p>
        <p className="text-muted">
          {action.rpc === 'staff_add_visit'
            ? t('console.offline.review.addRefused')
            : visit
              ? t('console.offline.review.nowIn', {
                  state: t(`console.offline.state.${visit.status}`),
                })
              : t('console.offline.review.gone')}
        </p>
      </div>
      <Badge tone="warning">{t('console.offline.review.nothingApplied')}</Badge>
      <Button variant="secondary" disabled={!canRetry} onClick={() => void again()}>
        {t('console.offline.review.apply')}
      </Button>
      <ConfirmDestructive
        triggerLabel={t('console.offline.review.discard')}
        triggerVariant="secondary"
        triggerAriaLabel={t('console.offline.review.discardLabel', { ticket: who })}
        title={t('console.offline.review.discardTitle', { ticket: who })}
        description={t('console.offline.review.discardBody')}
        confirmLabel={t('console.offline.review.discard')}
        cancelLabel={t('console.confirm.cancel')}
        onConfirm={() => offlineQueue().discard(action.id)}
      />
    </li>
  );
}
