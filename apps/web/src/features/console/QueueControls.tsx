import { Button, Card, ConfirmDestructive } from '@qm/ui';
import { useTranslation } from '../../lib/translation.tsx';
import { useSetQueueState, type ConsoleQueue } from './api.ts';

const KNOWN_ERRORS = ['org_suspended'];

/**
 * C7 (#64): open, pause or close the queue on this tab. Pausing is its own undo (Resume), so it
 * needs no confirmation; closing goes through ConfirmDestructive (I-9). Either way the guests
 * already waiting stay in line; the database decides that, this only says it.
 */
export function QueueControls({
  queue,
  locationId,
  disabled = false,
}: {
  queue: ConsoleQueue;
  locationId: string;
  /** Offline: the database is not reachable, so state changes wait (S-12). */
  disabled?: boolean;
}) {
  const { t } = useTranslation('staff');
  const change = useSetQueueState(locationId);
  const state = queue.manualState;
  const set = (next: ConsoleQueue['manualState']) => {
    change.reset();
    // A failure shows in the alert below.
    return change.mutateAsync({ queueId: queue.id, state: next }).catch(() => {});
  };
  const failure = change.error
    ? `console.controls.error.${KNOWN_ERRORS.includes(change.error.message) ? change.error.message : 'unknown'}`
    : null;

  return (
    <Card className="mb-4 flex flex-col gap-3" data-testid="queue-controls">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">{t(`console.controls.status.${state}`)}</p>
          <p className="text-muted">{t(`console.controls.explain.${state}`)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {state === 'open' ? (
            <Button
              variant="secondary"
              disabled={disabled}
              loading={change.isPending}
              loadingLabel={t('console.controls.saving')}
              onClick={() => void set('paused')}
            >
              {t('console.controls.pause')}
            </Button>
          ) : (
            <Button
              disabled={disabled}
              loading={change.isPending}
              loadingLabel={t('console.controls.saving')}
              onClick={() => void set('open')}
            >
              {t(state === 'paused' ? 'console.controls.resume' : 'console.controls.open')}
            </Button>
          )}
          {state === 'closed' ? null : (
            <ConfirmDestructive
              triggerLabel={t('console.controls.close')}
              title={t('console.controls.closeTitle', { name: queue.name })}
              description={t('console.controls.closeDescription')}
              confirmLabel={t('console.controls.closeConfirm')}
              cancelLabel={t('console.controls.closeCancel')}
              disabled={change.isPending || disabled}
              onConfirm={() => set('closed')}
            />
          )}
        </div>
      </div>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'console.controls.error.unknown') : null}
      </p>
    </Card>
  );
}
