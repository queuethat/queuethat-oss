import { Button, Dialog, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import type { ConsoleQueue, ConsoleVisit } from '../api.ts';

/** Moves a waiting visit; resolves true when it went through, so the dialog closes. */
export type OnTransfer = (
  visit: ConsoleVisit,
  toQueueId: string,
  toServiceId: string | null,
) => Promise<boolean>;

/**
 * Sends a waiting guest to another queue or service in one step (S-5, #136). The guest keeps
 * their place by join time, so the dialog only picks the target; the database files the visit
 * and keeps or reissues the ticket. A target that takes no joins is refused by the database.
 */
export function TransferDialog({
  visit,
  queues,
  onTransfer,
  onClose,
}: {
  visit: ConsoleVisit;
  queues: ConsoleQueue[];
  onTransfer: OnTransfer;
  onClose: () => void;
}) {
  const { t } = useTranslation('staff');
  const [queueId, setQueueId] = useState(visit.queueId);
  const [serviceId, setServiceId] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = queues.find((q) => q.id === queueId);
  const sameQueue = queueId === visit.queueId;
  // Within one queue a service must be picked, or there is nothing to change.
  const nothingToDo = sameQueue && serviceId === '';
  const confirm = async () => {
    setBusy(true);
    const ok = await onTransfer(visit, queueId, serviceId || null);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('console.transfer.title', { ticket: visit.ticket })}
      description={t('console.transfer.place')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('console.transfer.cancel')}
          </Button>
          <Button loading={busy} disabled={nothingToDo} onClick={() => void confirm()}>
            {t('console.transfer.confirm')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label={t('console.transfer.queue')}
          value={queueId}
          onChange={(event) => {
            setQueueId(event.target.value);
            setServiceId('');
          }}
        >
          {queues.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </Select>
        <Select
          label={t('console.transfer.service')}
          hint={sameQueue ? undefined : t('console.transfer.serviceHint')}
          value={serviceId}
          onChange={(event) => setServiceId(event.target.value)}
        >
          <option value="">
            {sameQueue ? t('console.transfer.keepService') : t('console.transfer.noService')}
          </option>
          {(queue?.services ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
    </Dialog>
  );
}
