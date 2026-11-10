import { formatLocalTime } from '@qm/domain';
import { Button, Dialog, Spinner } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useVisitHistory, type DoneVisit } from '../api.ts';
import { EditTimes } from './edit-times/EditTimes.tsx';
import { timeline } from './entries.ts';

/**
 * Who did what to a visit and when (S-16, #139), in the location's time zone: actions, reasons,
 * undone actions struck through with who undid them, and what was sent to the guest and how it
 * went. Contact details are never part of it.
 */
export function HistoryDrawer({
  visitId,
  ticket,
  timeZone,
  editable,
  onClose,
}: {
  visitId: string;
  ticket: string;
  timeZone: string;
  /** A finished visit whose times may be corrected from here (S-18). */
  editable?: DoneVisit;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('staff');
  const history = useVisitHistory(visitId);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('console.history.title', { ticket })}
        footer={
          <div className="flex justify-end gap-2">
            {editable ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('console.editTimes.open')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              {t('console.history.close')}
            </Button>
          </div>
        }
      >
        {history.isPending ? (
          <Spinner label={t('console.history.loading')} className="mx-auto my-4" />
        ) : history.isError ? (
          <p role="alert">{t('console.history.error')}</p>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="history">
            {timeline(history.data).map((e, i) => {
              const undone = e.summary.undone === true;
              return (
                <li key={i} className="flex flex-col" data-testid="history-entry">
                  <span className="text-muted tabular-nums">
                    {formatLocalTime(e.at, timeZone, i18n.language)} · {e.actor}
                  </span>
                  <span className={undone ? 'line-through' : undefined}>
                    {e.type === 'times_corrected'
                      ? t('console.history.correctedBy', { name: e.actor })
                      : t(`console.history.type.${e.type}`, { defaultValue: e.type })}
                    {e.type === 'notification'
                      ? ` · ${Object.entries(e.summary)
                          .filter(([k]) => k === 'channel' || k === 'status')
                          .map(([, v]) => String(v))
                          .join(' · ')}`
                      : ''}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </span>
                  {e.type === 'times_corrected'
                    ? correctedFields(e.summary).map((c) => (
                        <span key={c.field} className="text-muted tabular-nums">
                          {t(`console.editTimes.field.${c.field}`)}:{' '}
                          {c.before ? formatLocalTime(c.before, timeZone, i18n.language) : '—'} →{' '}
                          {c.after ? formatLocalTime(c.after, timeZone, i18n.language) : '—'}
                        </span>
                      ))
                    : null}
                  {undone ? (
                    <span className="text-muted">
                      {e.undoneBy
                        ? t('console.history.undoneBy', { name: e.undoneBy })
                        : t('console.history.undone')}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Dialog>
      {editing && editable ? (
        <EditTimes
          visit={editable}
          timeZone={timeZone}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

const CORRECTABLE = [
  ['called_at', 'calledAt'],
  ['serving_at', 'servingAt'],
  ['finished_at', 'finishedAt'],
] as const;

/** The times a `times_corrected` event changed, with old and new values (from its payload). */
function correctedFields(summary: Record<string, unknown>) {
  const before = (summary['before'] ?? {}) as Record<string, string | null>;
  const after = (summary['after'] ?? {}) as Record<string, string | null>;
  return CORRECTABLE.filter(([key]) => (before[key] ?? null) !== (after[key] ?? null)).map(
    ([key, field]) => ({ field, before: before[key] ?? null, after: after[key] ?? null }),
  );
}
