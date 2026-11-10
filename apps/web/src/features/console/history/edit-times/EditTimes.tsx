import { atLocalTime, errorCode, formatLocalTime, localTimeValue } from '@qm/domain';
import { Button, Dialog, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCorrectTimes, type DoneVisit } from '../../api.ts';

type Field = 'calledAt' | 'servingAt' | 'finishedAt';

/**
 * Corrects a finished visit's called, serving and finished times (S-18, #146). Times are entered
 * on the location's wall clock and shown next to the original. Only the fields that changed are
 * sent; the database has the last word on order and on who may correct (`invalid_times`,
 * `permission_denied`). The checks here only spare staff a round trip.
 */
export function EditTimes({
  visit,
  timeZone,
  onClose,
  onSaved,
}: {
  visit: DoneVisit;
  timeZone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation('staff');
  const correct = useCorrectTimes();
  const original: Record<Field, string | null> = {
    calledAt: visit.calledAt,
    servingAt: visit.status === 'no_show' ? null : visit.servingAt,
    finishedAt: visit.finishedAt || null,
  };
  const fields = (['calledAt', 'servingAt', 'finishedAt'] as const).filter((f) => original[f]);
  const [values, setValues] = useState<Record<Field, string>>(() => ({
    calledAt: original.calledAt ? localTimeValue(original.calledAt, timeZone) : '',
    servingAt: original.servingAt ? localTimeValue(original.servingAt, timeZone) : '',
    finishedAt: original.finishedAt ? localTimeValue(original.finishedAt, timeZone) : '',
  }));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const changed = fields.filter(
    (f) => values[f] !== '' && values[f] !== localTimeValue(original[f]!, timeZone),
  );
  const instant = (f: Field): number =>
    changed.includes(f)
      ? atLocalTime(values[f], original[f]!, timeZone).getTime()
      : Date.parse(original[f]!);

  /** The message key for the first problem with the entered times, or null. */
  const problem = (): 'order' | 'future' | null => {
    const chain = [Date.parse(visit.joinedAt), ...fields.map(instant)];
    if (chain.some((v, i) => i > 0 && v < chain[i - 1]!)) return 'order';
    if (chain.some((v) => v > Date.now())) return 'future';
    return null;
  };

  const submit = () => {
    const found = problem();
    if (found) return setError(t(`console.editTimes.error.${found}`));
    const iso = (f: Field) => (changed.includes(f) ? new Date(instant(f)).toISOString() : null);
    correct.mutate(
      {
        visit,
        calledAt: iso('calledAt'),
        servingAt: iso('servingAt'),
        finishedAt: iso('finishedAt'),
        reason: reason.trim(),
      },
      {
        onSuccess: onSaved,
        onError: (e) => {
          const code = errorCode(e);
          setError(
            t(`console.editTimes.error.${code}`, {
              defaultValue: t('console.editTimes.error.unknown'),
            }),
          );
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('console.editTimes.title', { ticket: visit.ticket })}
      description={t('console.editTimes.hint')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('console.editTimes.cancel')}
          </Button>
          <Button
            loading={correct.isPending}
            disabled={changed.length === 0 || reason.trim() === ''}
            onClick={submit}
          >
            {t('console.editTimes.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {fields.map((f) => (
          <Input
            key={f}
            type="time"
            label={t(`console.editTimes.field.${f}`)}
            hint={t('console.editTimes.was', {
              time: formatLocalTime(original[f]!, timeZone, i18n.language),
            })}
            value={values[f]}
            onChange={(event) => {
              setError(null);
              setValues({ ...values, [f]: event.target.value });
            }}
          />
        ))}
        <Input
          label={t('console.editTimes.reason')}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
