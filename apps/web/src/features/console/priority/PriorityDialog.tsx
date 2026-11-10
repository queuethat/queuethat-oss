import { Button, Dialog, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { PriorityClass } from '../../admin/priority/api.ts';
import type { ConsoleVisit } from '../api.ts';

/** Sets a waiting visit's priority class, or clears it with null. Resolves true when it went through. */
export type OnPriority = (visit: ConsoleVisit, classId: string | null) => Promise<boolean>;

/**
 * Picks a priority class for a waiting guest (Q-10). The database refiles the guest by the class
 * offset unless staff placed them by hand, which keeps their place.
 */
export function PriorityDialog({
  visit,
  classes,
  onPriority,
  onClose,
}: {
  visit: ConsoleVisit;
  classes: PriorityClass[];
  onPriority: OnPriority;
  onClose: () => void;
}) {
  const { t } = useTranslation('staff');
  const [classId, setClassId] = useState(visit.priorityClassId ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await onPriority(visit, classId || null);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('console.priority.title', { ticket: visit.ticket })}
      description={t('console.priority.hint')}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('console.priority.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={(visit.priorityClassId ?? '') === classId}
            onClick={() => void save()}
          >
            {t('console.priority.save')}
          </Button>
        </div>
      }
    >
      <Select
        label={t('console.priority.pick')}
        value={classId}
        onChange={(e) => setClassId(e.target.value)}
      >
        <option value="">{t('console.priority.none')}</option>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}
