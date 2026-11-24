// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import { errorCode } from '@qm/domain';
import { BigButton, Button, Dialog, Input, useToast } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '@app/lib/translation.tsx';
import type { AppointmentRow } from '@app/features/appointments/api.ts';
import { formatTime } from '@app/features/booking/slots.ts';
import { useBlockTime, useUnblockTime } from './api.ts';

export interface BlockRequest {
  resources: { id: string; label: string }[];
  start: Date;
  end: Date;
  /** Bookings the block would run into; they stay booked. */
  conflicts: AppointmentRow[];
}

/**
 * Summary of a drag or keyboard selection (2B-A11): which resources, which time range, the bookings
 * it overlaps, and a reason. Confirming calls api.block_time_bulk; the toast undoes it.
 */
export function BlockDialog({
  request,
  locationId,
  tz,
  onClose,
}: {
  request: BlockRequest | null;
  locationId: string;
  tz: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('planning');
  const toast = useToast();
  const [reason, setReason] = useState('');
  const block = useBlockTime(locationId);
  const unblock = useUnblockTime();
  if (!request) return null;
  const time = (d: Date) => formatTime(d.toISOString(), tz, i18n.language);

  function confirm() {
    block.mutate(
      {
        resourceIds: request!.resources.map((r) => r.id),
        start: request!.start,
        end: request!.end,
        reason,
      },
      {
        onSuccess: (result) => {
          toast.undo(t('block.done', { count: result.block_ids.length }), () =>
            unblock.mutate(result.block_ids),
          );
          setReason('');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('block.title')}
      description={t('block.summary', {
        count: request.resources.length,
        from: time(request.start),
        to: time(request.end),
      })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('block.cancel')}
          </Button>
          <BigButton onClick={confirm} disabled={block.isPending}>
            {t('block.confirm')}
          </BigButton>
        </>
      }
    >
      <p className="font-medium">{request.resources.map((r) => r.label).join(', ')}</p>
      <Input
        label={t('block.reason')}
        value={reason}
        maxLength={200}
        onChange={(e) => setReason(e.target.value)}
      />
      {request.conflicts.length > 0 ? (
        <div role="status">
          <p className="font-medium text-warning-strong">
            {t('block.conflicts', { count: request.conflicts.length })}
          </p>
          <ul className="list-disc pl-5">
            {request.conflicts.map((a) => (
              <li key={a.id}>
                {time(new Date(a.starts_at))} {a.guest_name ?? ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {block.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(`block.error.${errorCode(block.error) === 'permission_denied' ? 'denied' : 'failed'}`)}
        </p>
      ) : null}
    </Dialog>
  );
}
