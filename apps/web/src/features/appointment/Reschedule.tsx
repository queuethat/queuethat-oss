import { errorCode } from '@qm/domain';
import { BigButton, Button, Card, Spinner } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useRescheduleAppointment, useServiceSlots } from '../booking/api.ts';
import { SlotPicker } from '../booking/SlotPicker.tsx';
import { formatWhen } from '../booking/slots.ts';

/** Picks a new time for an appointment and asks once more before moving it. */
export function Reschedule({
  token,
  slug,
  serviceId,
  tz,
  onClose,
  onProblem,
}: {
  token: string;
  slug: string;
  serviceId: string;
  tz: string;
  onClose: () => void;
  onProblem: (code: string | null) => void;
}) {
  const { t, i18n } = useTranslation('booking');
  const move = useRescheduleAppointment(token);
  const [pending, setPending] = useState<string | null>(null);
  const availability = useServiceSlots(slug, [serviceId], tz);

  function confirmMove() {
    if (!pending || move.isPending) return;
    onProblem(null);
    move.mutate(pending, {
      onSuccess: onClose,
      onError: (error) => {
        onProblem(errorCode(error));
        setPending(null);
        void availability.refresh();
      },
    });
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="move-title">
      <h2 id="move-title" className="text-xl font-semibold">
        {t('appointment.rescheduleTitle')}
      </h2>
      {availability.isPending ? (
        <Spinner label={t('book.loading')} />
      ) : pending ? (
        <Card className="flex flex-col gap-3">
          <p className="font-semibold">{formatWhen(pending, tz, i18n.language)}</p>
          <BigButton
            loading={move.isPending}
            loadingLabel={t('book.submitting')}
            onClick={confirmMove}
          >
            {t('appointment.confirmMove', { when: formatWhen(pending, tz, i18n.language) })}
          </BigButton>
          <Button variant="secondary" onClick={() => setPending(null)}>
            {t('book.back')}
          </Button>
        </Card>
      ) : (
        <SlotPicker slots={availability.slots[serviceId] ?? []} tz={tz} onPick={setPending} />
      )}
      <Button variant="secondary" onClick={onClose}>
        {t('appointment.keepTime')}
      </Button>
    </section>
  );
}
