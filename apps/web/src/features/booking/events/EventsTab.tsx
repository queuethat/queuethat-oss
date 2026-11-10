import { errorCode } from '@qm/domain';
import { Badge, Button, Card, EmptyState, Input, Spinner } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useBookingLocation } from '../api.ts';
import type { Details } from '../DetailsForm.tsx';
import { formatWhen } from '../slots.ts';
import { useBookEventSeats, useLocationEvents, type PublicEvent } from './api.ts';

const DetailsForm = lazy(() =>
  import('../DetailsForm.tsx').then((m) => ({ default: m.DetailsForm })),
);

const KNOWN_ERRORS = ['event_full', 'rate_limited', 'org_suspended', 'not_found', 'invalid_input'];

/**
 * The booking page's Events tab (A-10): upcoming public events with seats left as a number,
 * and a booking form with party size. The database decides whether the seats are still there
 * (`event_full`); on a lost race the list refreshes.
 */
export function EventsTab({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation('booking');
  const navigate = useNavigate();
  const location = useBookingLocation(slug);
  const events = useLocationEvents(slug);
  const book = useBookEventSeats();
  const [picked, setPicked] = useState<PublicEvent | null>(null);
  const [seats, setSeats] = useState('1');
  const [problem, setProblem] = useState<string | null>(null);
  const submitted = useRef(false);
  const tz = location.data?.tz ?? 'UTC';

  if (events.isPending || location.isPending)
    return <Spinner label={t('events.loading')} className="mx-auto my-8" />;
  if (events.isError || location.isError)
    return (
      <EmptyState title={t('book.loadFailed.title')} description={t('book.loadFailed.body')} />
    );
  if (events.data.length === 0) return <EmptyState title={t('events.none')} />;

  const left = (e: PublicEvent) => e.capacity - e.seats_taken;
  const party = Number(seats);

  function submit(details: Details) {
    if (!picked || submitted.current) return;
    submitted.current = true;
    setProblem(null);
    book.mutate(
      {
        eventId: picked.id,
        name: details.name,
        phoneE164: details.phoneE164,
        email: details.email,
        seats: party,
      },
      {
        onSuccess: ({ token }) => void navigate({ to: '/a/$token', params: { token } }),
        onError: (error) => {
          submitted.current = false;
          const code = errorCode(error);
          setProblem(KNOWN_ERRORS.includes(code) ? code : 'unknown');
          if (code === 'event_full') {
            setPicked(null);
            void events.refetch();
          }
        },
      },
    );
  }

  if (picked) {
    const max = Math.min(20, left(picked));
    return (
      <Suspense fallback={<Spinner label={t('events.loading')} />}>
        <DetailsForm
          summary={t('events.summary', {
            title: picked.title,
            when: formatWhen(picked.starts_at, tz, i18n.language),
          })}
          countryCode={location.data.countryCode}
          retentionDays={location.data.retentionDays}
          problem={problem}
          pending={book.isPending}
          contactRequired
          onBack={() => setPicked(null)}
          onSubmit={(details) => {
            if (Number.isInteger(party) && party >= 1 && party <= max) submit(details);
          }}
          extra={
            <Input
              label={t('events.party')}
              hint={t('events.partyHint', { count: max })}
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
            />
          }
        />
      </Suspense>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {problem ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(`events.error.${problem}` as 'events.error.unknown')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3" aria-label={t('events.list')}>
        {events.data.map((e) => (
          <li key={e.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">{e.title}</p>
                <p className="text-muted">{formatWhen(e.starts_at, tz, i18n.language)}</p>
                {left(e) > 0 ? (
                  <p>{t('events.seatsLeft', { count: left(e) })}</p>
                ) : (
                  <Badge tone="neutral">{t('events.full')}</Badge>
                )}
              </div>
              {left(e) > 0 ? (
                <Button
                  aria-label={t('events.bookFor', { title: e.title })}
                  onClick={() => {
                    setSeats('1');
                    setProblem(null);
                    setPicked(e);
                  }}
                >
                  {t('events.book')}
                </Button>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
