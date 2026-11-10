import { Button, Dialog, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { ConsoleVisit } from '../api.ts';

export interface AssignTargets {
  counters: { id: string; label: string }[];
  staff: { userId: string; name: string }[];
}

/** Assigns a waiting visit; both null unassigns. Resolves true when it went through. */
export type OnAssign = (
  visit: ConsoleVisit,
  counterId: string | null,
  staffUserId: string | null,
) => Promise<boolean>;

/**
 * Picks who may be offered a waiting guest (Q-18): a counter, a person, or both. The guest stays
 * on everyone's list; only the assignee's Call next picks them. "Unassign" opens them to all.
 */
export function AssignDialog({
  visit,
  targets,
  onAssign,
  onClose,
}: {
  visit: ConsoleVisit;
  targets: AssignTargets;
  onAssign: OnAssign;
  onClose: () => void;
}) {
  const { t } = useTranslation('staff');
  const [counterId, setCounterId] = useState(visit.assignedCounterId ?? '');
  const [staffId, setStaffId] = useState(visit.assignedStaffId ?? '');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const assigned = !!(visit.assignedCounterId || visit.assignedStaffId);
  const run = async (kind: 'save' | 'clear') => {
    setBusy(kind);
    const ok =
      kind === 'clear'
        ? await onAssign(visit, null, null)
        : await onAssign(visit, counterId || null, staffId || null);
    setBusy(null);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('console.assign.title', { ticket: visit.ticket })}
      description={t('console.assign.hint')}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {assigned ? (
            <Button
              variant="secondary"
              loading={busy === 'clear'}
              onClick={() => void run('clear')}
            >
              {t('console.assign.clear')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('console.assign.cancel')}
          </Button>
          <Button
            loading={busy === 'save'}
            disabled={counterId === '' && staffId === ''}
            onClick={() => void run('save')}
          >
            {t('console.assign.confirm')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label={t('console.assign.staff')}
          value={staffId}
          onChange={(event) => setStaffId(event.target.value)}
        >
          <option value="">{t('console.assign.anyone')}</option>
          {targets.staff.map((s) => (
            <option key={s.userId} value={s.userId}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          label={t('console.assign.counter')}
          value={counterId}
          onChange={(event) => setCounterId(event.target.value)}
        >
          <option value="">{t('console.assign.anyCounter')}</option>
          {targets.counters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
    </Dialog>
  );
}

/** "For Ben" / "For Room 2" / "For Ben · Room 2": who an assigned guest is waiting for. */
export function assigneeLabel(
  visit: Pick<ConsoleVisit, 'assignedStaffId' | 'assignedCounterId'>,
  targets: AssignTargets,
  fallback: string,
): string | null {
  const staff = visit.assignedStaffId
    ? (targets.staff.find((s) => s.userId === visit.assignedStaffId)?.name ?? fallback)
    : null;
  const counter = visit.assignedCounterId
    ? (targets.counters.find((c) => c.id === visit.assignedCounterId)?.label ?? fallback)
    : null;
  const parts = [staff, counter].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(' · ') : null;
}
