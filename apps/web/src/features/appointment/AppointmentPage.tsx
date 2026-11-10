import { errorCode } from '@qm/domain';
import { Button, Card, ConfirmDestructive, EmptyState, LinkButton, Spinner } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useAppointment, useBookingLocation, useCancelAppointment } from '../booking/api.ts';
import { requestPayment, type PaymentIntentInfo } from '../booking/payment/api.ts';
import { formatWhen, zoneName } from '../booking/slots.ts';
import { BookingStatusPill } from '../guest/BookingStatusPill.tsx';
import { Reminders } from './Reminders.tsx';

// The slot picker and the move flow load only when a guest asks to change the time.
const Reschedule = lazy(() => import('./Reschedule.tsx').then((m) => ({ default: m.Reschedule })));
// Stripe.js loads only for a guest whose booking is still waiting for its card.
const PaymentStep = lazy(() => import('../booking/payment/PaymentStep.tsx'));

/**
 * `/a/:token` (A-6): the guest's one handle on a booking. Everything shown comes from
 * api.get_appointment; unknown and expired links read the same. Whether it can still be moved
 * or cancelled is the database's answer (`can_reschedule`, `can_cancel`).
 */
export function AppointmentPage({ token }: { token: string }) {
  const { t, i18n } = useTranslation('booking');
  const appointment = useAppointment(token);
  // The appointment carries the location's slug; its timezone and services come from the public location.
  const slug = appointment.data?.location_slug;
  const location = useBookingLocation(slug ?? '', slug !== undefined);
  const cancel = useCancelAppointment(token);
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [paying, setPaying] = useState<PaymentIntentInfo | null>(null);
  const queryClient = useQueryClient();
  // The "I didn't book this" link in the confirmation email: same page, the cancel button below is the action.
  const notYou = new URLSearchParams(window.location.search).get('cancel') === '1';
  // get_appointment names the service but gives no id; names are unique enough within one location.
  const serviceId = location.data?.services.find(
    (s) => s.name === appointment.data?.service_name,
  )?.id;

  if (appointment.isPending || (appointment.data && location.isPending))
    return <Spinner label={t('appointment.loading')} className="mx-auto my-16" />;
  if (appointment.isError) {
    const missing = errorCode(appointment.error) === 'not_found';
    return (
      <EmptyState
        title={t(missing ? 'appointment.notFound.title' : 'book.loadFailed.title')}
        description={t(missing ? 'appointment.notFound.body' : 'book.loadFailed.body')}
      />
    );
  }
  const a = appointment.data;
  const tz = location.data?.tz ?? 'UTC';
  const cancelled = a.status === 'cancelled';
  const pending = a.status === 'pending_payment';

  async function addCard() {
    setProblem(null);
    try {
      // A null answer means the service stopped asking for a card: the next refresh shows it booked.
      const info = await requestPayment(token, crypto.randomUUID());
      if (info) setPaying(info);
      else void queryClient.invalidateQueries({ queryKey: ['booking', 'appointment', token] });
    } catch {
      setProblem('payment_unavailable');
    }
  }

  async function downloadIcs() {
    // Loaded on demand: most guests never download the file.
    const { appointmentIcs, appointmentUid } = await import('./ics.ts');
    const uid = await appointmentUid(token);
    const blob = new Blob(
      [
        appointmentIcs({
          service: a.service_name,
          place: a.location_name,
          startsAt: a.starts_at,
          endsAt: a.ends_at,
          uid,
        }),
      ],
      { type: 'text/calendar' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'appointment.ics';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (paying)
    return (
      <div className="py-4">
        <Suspense fallback={<Spinner label={t('payment.loading')} className="mx-auto my-16" />}>
          <PaymentStep info={paying} token={token} onDone={() => setPaying(null)} />
        </Suspense>
      </div>
    );

  return (
    <div className="flex flex-col gap-6 py-4">
      <h1 className="text-3xl font-bold">{t('appointment.title')}</h1>
      <Card className="flex flex-col gap-1" data-testid="appointment">
        <BookingStatusPill status={a.status}>
          {t(`appointment.status.${a.status}` as 'appointment.status.booked')}
        </BookingStatusPill>
        <p className="text-xl font-semibold">{a.service_name}</p>
        <p>{a.location_name}</p>
        <p data-testid="appointment-when">{formatWhen(a.starts_at, tz, i18n.language)}</p>
        <p className="text-sm text-muted">{zoneName(a.starts_at, tz, i18n.language)}</p>
      </Card>

      {notYou && !cancelled && a.can_cancel ? (
        <p role="note" className="font-medium">
          {t('appointment.notYou')}
        </p>
      ) : null}

      {cancelled || a.status !== 'booked' ? null : <Reminders token={token} />}

      {pending ? (
        <div className="flex flex-col gap-3">
          <p role="status">{t('appointment.pending')}</p>
          <Button onClick={() => void addCard()}>{t('appointment.addCard')}</Button>
        </div>
      ) : null}

      {problem ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(problemKey(problem))}
        </p>
      ) : null}

      {cancelled ? (
        <>
          <p role="status">{t('appointment.cancelled')}</p>
          <LinkButton
            variant="secondary"
            render={(p) => (
              <Link to="/b/$locationSlug" params={{ locationSlug: a.location_slug }} {...p} />
            )}
          >
            {t('appointment.bookAgain')}
          </LinkButton>
        </>
      ) : moving && serviceId ? (
        <Suspense fallback={<Spinner label={t('book.loading')} />}>
          <Reschedule
            token={token}
            slug={a.location_slug}
            serviceId={serviceId}
            tz={tz}
            onClose={() => setMoving(false)}
            onProblem={setProblem}
          />
        </Suspense>
      ) : (
        <div className="flex flex-col gap-3">
          <Button variant="secondary" onClick={() => void downloadIcs()}>
            {t('appointment.addToCalendar')}
          </Button>
          {a.can_reschedule && serviceId ? (
            <Button
              variant="secondary"
              onClick={() => {
                setProblem(null);
                setMoving(true);
              }}
            >
              {t('appointment.reschedule')}
            </Button>
          ) : null}
          {a.can_cancel ? (
            <ConfirmDestructive
              triggerLabel={t('appointment.cancelTrigger')}
              title={t('appointment.cancelTitle')}
              description={t('appointment.cancelBody')}
              confirmLabel={t('appointment.cancelConfirm')}
              cancelLabel={t('appointment.cancelKeep')}
              onConfirm={() =>
                cancel.mutateAsync().catch((error: unknown) => setProblem(errorCode(error)))
              }
            />
          ) : null}
          {!a.can_reschedule && a.can_cancel ? (
            <p className="text-sm text-muted">{t('appointment.tooLate')}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function problemKey(code: string) {
  if (code === 'payment_unavailable') return 'appointment.payUnavailable' as const;
  if (code === 'too_late_to_change') return 'appointment.tooLate' as const;
  if (code === 'slot_full' || code === 'slot_unavailable')
    return 'appointment.rescheduleTaken' as const;
  return 'book.error.unknown' as const;
}
