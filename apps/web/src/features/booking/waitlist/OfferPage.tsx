import { errorCode } from '@qm/domain';
import {
  BigButton,
  Button,
  Card,
  ConfirmDestructive,
  EmptyState,
  LinkButton,
  Spinner,
} from '@qm/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { BookingStatusPill } from '../../guest/BookingStatusPill.tsx';
import { useBookingLocation } from '../api.ts';
import { formatDay, formatTime, formatWhen, zoneName } from '../slots.ts';
import { useClaimOffer, useLeaveWaitlist, useWaitlistEntry } from './api.ts';

/**
 * `/o/:token` (A-9): the guest's waitlist entry. Waiting shows what they are waiting for; an open offer shows
 * the held slot, how long it is held (worded from the server's clock, not a local countdown) and Claim / No thanks.
 * Claiming lands on `/a/:token`: the same token opens the appointment.
 */
export function OfferPage({ token }: { token: string }) {
  const { t, i18n } = useTranslation('booking');
  const navigate = useNavigate();
  const entry = useWaitlistEntry(token);
  const slug = entry.data?.location_slug;
  const location = useBookingLocation(slug ?? '', slug !== undefined);
  const claim = useClaimOffer(token);
  const leave = useLeaveWaitlist(token);
  const [problem, setProblem] = useState<string | null>(null);

  if (entry.isPending || (entry.data && location.isPending))
    return <Spinner label={t('offer.loading')} className="mx-auto my-16" />;
  if (entry.isError) {
    const missing = errorCode(entry.error) === 'not_found';
    return (
      <EmptyState
        title={t(missing ? 'offer.notFound.title' : 'book.loadFailed.title')}
        description={t(missing ? 'offer.notFound.body' : 'book.loadFailed.body')}
      />
    );
  }
  const w = entry.data;
  const tz = location.data?.tz ?? 'UTC';
  const lang = i18n.language;
  const minutesLeft =
    w.offer_expires_at === null
      ? 0
      : Math.max(0, Math.ceil((Date.parse(w.offer_expires_at) - Date.parse(w.as_of)) / 60_000));

  function onClaim() {
    setProblem(null);
    claim.mutate(undefined, {
      onSuccess: () => void navigate({ to: '/a/$token', params: { token } }),
      onError: (error) => {
        const code = errorCode(error);
        setProblem(
          ['offer_expired', 'slot_taken', 'not_found', 'rate_limited'].includes(code)
            ? code
            : 'unknown',
        );
        void entry.refetch();
      },
    });
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <h1 className="text-3xl font-bold">{t('offer.title')}</h1>
      <Card role="status" className="flex flex-col gap-1">
        <BookingStatusPill status={w.status}>
          {t(`offer.status.${w.status}` as 'offer.status.waiting')}
        </BookingStatusPill>
        <p className="text-xl font-semibold">{w.service_name}</p>
        <p>{w.location_name}</p>
        {w.status === 'waiting' ? (
          <p>{t('offer.waitingFor', { day: formatDay(w.wanted_day, lang) })}</p>
        ) : null}
        {w.status === 'offered' && w.slot_start ? (
          <>
            <p data-testid="offer-when">{formatWhen(w.slot_start, tz, lang)}</p>
            <p className="text-sm text-muted">{zoneName(w.slot_start, tz, lang)}</p>
            <p data-testid="offer-hold">
              {t('offer.holdLeft', {
                count: minutesLeft,
                until: formatTime(w.offer_expires_at!, tz, lang),
                asOf: formatTime(w.as_of, tz, lang),
              })}
            </p>
          </>
        ) : null}
      </Card>

      {problem ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(`offer.error.${problem}` as 'offer.error.unknown')}
        </p>
      ) : null}

      {w.status === 'offered' ? (
        <div className="flex flex-col gap-3">
          <BigButton onClick={onClaim} loading={claim.isPending} loadingLabel={t('offer.claiming')}>
            {t('offer.claim')}
          </BigButton>
          <ConfirmDestructive
            triggerLabel={t('offer.decline')}
            title={t('offer.declineTitle')}
            description={t('offer.declineBody')}
            confirmLabel={t('offer.declineConfirm')}
            cancelLabel={t('offer.declineKeep')}
            triggerVariant="secondary"
            onConfirm={async () => {
              await leave.mutateAsync();
            }}
          />
        </div>
      ) : null}

      {w.status === 'waiting' ? (
        <ConfirmDestructive
          triggerLabel={t('offer.leave')}
          title={t('offer.leaveTitle')}
          description={t('offer.leaveBody')}
          confirmLabel={t('offer.leaveConfirm')}
          cancelLabel={t('offer.leaveKeep')}
          triggerVariant="secondary"
          onConfirm={async () => {
            await leave.mutateAsync();
          }}
        />
      ) : null}

      {w.status === 'claimed' ? (
        <LinkButton render={(p) => <Link to="/a/$token" params={{ token }} {...p} />}>
          {t('offer.viewBooking')}
        </LinkButton>
      ) : null}

      {w.status === 'expired' || w.status === 'cancelled' ? (
        <Button
          variant="secondary"
          onClick={() =>
            void navigate({ to: '/b/$locationSlug', params: { locationSlug: w.location_slug } })
          }
        >
          {t('appointment.bookAgain')}
        </Button>
      ) : null}
    </div>
  );
}
