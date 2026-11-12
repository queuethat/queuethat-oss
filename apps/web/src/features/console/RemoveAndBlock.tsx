import { ConfirmDialog, Input, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import type { BlockDuration, ConsoleVisit } from './api.ts';

const DURATIONS: { key: 'day' | 'month' | 'forever'; days: BlockDuration }[] = [
  { key: 'day', days: 1 },
  { key: 'month', days: 30 },
  { key: 'forever', days: null },
];

/**
 * "Remove and block" for managers: removes the visit and blocks its phone, email and device for
 * a while (2P-PRV6, #193). The block can be lifted under Blocks, so a mistake is reversible.
 * The dialog is controlled: the row's overflow menu opens it, and nothing fires before the
 * separate confirm tap (I-9).
 */
export function RemoveAndBlock({
  visit,
  onBlock,
  onClose,
}: {
  visit: ConsoleVisit;
  onClose: () => void;
  onBlock: (visit: ConsoleVisit, reason: string, days: BlockDuration) => Promise<unknown>;
}) {
  const { t } = useTranslation('staff');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]['key']>('day');
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('console.block.title', { ticket: visit.ticket })}
      description={t('console.block.body')}
      confirmLabel={t('console.block.confirm')}
      cancelLabel={t('console.confirm.cancel')}
      confirmDisabled={reason.trim() === ''}
      onConfirm={() => onBlock(visit, reason, DURATIONS.find((d) => d.key === duration)!.days)}
    >
      <GuestLine visit={visit} />
      <Input
        label={t('console.block.reason')}
        hint={t('console.block.reasonHint')}
        value={reason}
        maxLength={200}
        onChange={(event) => setReason(event.target.value)}
      />
      <Select
        label={t('console.block.duration')}
        value={duration}
        onChange={(event) => setDuration(event.target.value as typeof duration)}
      >
        {DURATIONS.map((d) => (
          <option key={d.key} value={d.key}>
            {t(`console.block.for.${d.key}`)}
          </option>
        ))}
      </Select>
    </ConfirmDialog>
  );
}

/** Names the guest in a destructive confirmation, so staff see who they are acting on (I-9). */
export function GuestLine({ visit }: { visit: ConsoleVisit }) {
  const { t } = useTranslation('staff');
  return (
    <p className="font-medium" data-testid="confirm-guest">
      {t('console.confirm.guest', {
        ticket: visit.ticket,
        name: visit.name ?? t('console.noName'),
      })}
    </p>
  );
}
