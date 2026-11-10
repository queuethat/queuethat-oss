import { errorCode } from '@qm/domain';
import { Button, EmptyState, Select, Spinner, Tabs } from '@qm/ui';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useSetBookingAnswers } from '../guest/api.ts';
import { useBook, useBookingLocation, useServiceSlots } from './api.ts';
import { useLocationEvents } from './events/api.ts';
import type { Details } from './DetailsForm.tsx';
import type { Answers } from '../guest/api.ts';
import { requestPayment, type PaymentIntentInfo } from './payment/api.ts';
import { SlotPicker } from './SlotPicker.tsx';
import { formatWhen } from './slots.ts';

// The details form (and the phone picker inside it) loads once a time is chosen.
const DetailsForm = lazy(() =>
  import('./DetailsForm.tsx').then((m) => ({ default: m.DetailsForm })),
);

// Guests who never see an Events tab never download it.
const EventsTab = lazy(() =>
  import('./events/EventsTab.tsx').then((m) => ({ default: m.EventsTab })),
);

// Shown only when the database refused a booking's answers: off the route budget.
const AnswerStep = lazy(() => import('./AnswerStep.tsx').then((m) => ({ default: m.AnswerStep })));

// Stripe.js and the card step load only for a service with a payment policy.
const PaymentStep = lazy(() => import('./payment/PaymentStep.tsx'));
// Cloudflare's widget glue is only for deployments that turned Turnstile on.
const Turnstile = lazy(() =>
  import('../../components/Turnstile.tsx').then((m) => ({ default: m.Turnstile })),
);

const WaitlistForm = lazy(() =>
  import('./waitlist/WaitlistForm.tsx').then((m) => ({ default: m.WaitlistForm })),
);

const KNOWN_ERRORS = [
  'slot_full',
  'slot_unavailable',
  'rate_limited',
  'captcha_required',
  'captcha_failed',
  'org_suspended',
  'not_found',
];

/**
 * `/b/:slug`: appointments, and an Events tab (A-10) when the location has upcoming public events.
 * Without events the page is exactly the appointment flow.
 */
export function BookingPage({ slug, initialService }: { slug: string; initialService?: string }) {
  const { t } = useTranslation('booking');
  const events = useLocationEvents(slug);
  const [tab, setTab] = useState<'slots' | 'events'>('slots');
  if (!events.data?.length) return <SlotBooking slug={slug} initialService={initialService} />;
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        label={t('book.tabs.label')}
        panelId="booking-panel"
        value={tab}
        onChange={(id) => setTab(id as 'slots' | 'events')}
        items={[
          { id: 'slots', label: t('book.tabs.slots') },
          { id: 'events', label: t('book.tabs.events') },
        ]}
      />
      <div id="booking-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'slots' ? (
          <SlotBooking slug={slug} initialService={initialService} />
        ) : (
          <Suspense fallback={<Spinner label={t('events.loading')} />}>
            <EventsTab slug={slug} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/**
 * The appointment flow (A-1): pick a service, a day and a time, give a first name and optionally contact
 * details, book, land on the appointment page. The database decides which slots exist and
 * whether one is still free; this page renders that and refreshes when it loses a race.
 */
function SlotBooking({ slug, initialService }: { slug: string; initialService?: string }) {
  const { t, i18n } = useTranslation('booking');
  const navigate = useNavigate();
  const location = useBookingLocation(slug);
  const serviceIds = location.data?.services.map((s) => s.id) ?? [];
  const availability = useServiceSlots(slug, serviceIds, location.data?.tz ?? 'UTC');
  const book = useBook();
  const setAnswers = useSetBookingAnswers();
  const [answering, setAnswering] = useState<{
    token: string;
    queueId: string | null;
    serviceId: string;
    answers: Answers;
    error: unknown;
  } | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(initialService ?? null);
  const [slotStart, setSlotStart] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [waitlisting, setWaitlisting] = useState(false);
  // Only when the deployment turned Turnstile on; a token is single use, so every refusal starts a new round.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaRound, setCaptchaRound] = useState(0);
  const [paying, setPaying] = useState<{ token: string; info: PaymentIntentInfo } | null>(null);
  // Set synchronously: a second tap before the first answer would otherwise start another attempt.
  const submitted = useRef(false);

  if (location.isPending || (location.data && availability.isPending))
    return <Spinner label={t('book.loading')} className="mx-auto my-16" />;
  if (location.isError) {
    const missing = errorCode(location.error) === 'not_found';
    return (
      <EmptyState
        title={t(missing ? 'book.notFound.title' : 'book.loadFailed.title')}
        description={t(missing ? 'book.notFound.body' : 'book.loadFailed.body')}
      />
    );
  }
  if (availability.isError)
    return (
      <EmptyState title={t('book.loadFailed.title')} description={t('book.loadFailed.body')} />
    );

  const toAppointment = (token: string) => void navigate({ to: '/a/$token', params: { token } });
  const afterBooking = (token: string) =>
    void requestPayment(token, crypto.randomUUID())
      .then((info) => (info ? setPaying({ token, info }) : toAppointment(token)))
      .catch(() => toAppointment(token));
  if (answering)
    return (
      <Suspense fallback={<Spinner label={t('book.loading')} className="mx-auto my-16" />}>
        <AnswerStep
          token={answering.token}
          queueId={answering.queueId}
          serviceId={answering.serviceId}
          initial={answering.answers}
          initialError={answering.error}
          onDone={() => afterBooking(answering.token)}
        />
      </Suspense>
    );
  if (paying)
    return (
      <div className="py-4">
        <Suspense fallback={<Spinner label={t('payment.loading')} className="mx-auto my-16" />}>
          <PaymentStep
            info={paying.info}
            token={paying.token}
            onDone={() => toAppointment(paying.token)}
          />
        </Suspense>
      </div>
    );

  const { tz, captchaSiteKey: siteKey } = location.data;
  const bookable = location.data.services.filter(
    (s) => (availability.slots[s.id]?.length ?? 0) > 0,
  );
  const service =
    bookable.find((s) => s.id === serviceId) ?? (bookable.length === 1 ? bookable[0] : undefined);
  // Slots go stale while a guest types; the form stays only if its slot is still on offer.
  const slots = service ? (availability.slots[service.id] ?? []) : [];
  const chosen = slotStart && slots.some((s) => s.slot_start === slotStart) ? slotStart : null;
  const waitlist = (
    <Suspense fallback={<Spinner label={t('book.loading')} />}>
      <WaitlistForm
        slug={slug}
        tz={tz}
        services={location.data.services}
        countryCode={location.data.countryCode}
        retentionDays={location.data.retentionDays}
        captchaSiteKey={location.data.captchaSiteKey}
        onBack={() => setWaitlisting(false)}
      />
    </Suspense>
  );
  if (waitlisting) return waitlist;
  if (bookable.length === 0 && !book.isPending)
    return (
      <div className="flex flex-col gap-4">
        <EmptyState title={t('book.none.title')} description={t('book.none.body')} />
        <Button variant="secondary" onClick={() => setWaitlisting(true)}>
          {t('waitlist.join')}
        </Button>
      </div>
    );

  function submit(details: Details) {
    if (!service || !chosen || submitted.current) return;
    if (siteKey && !captchaToken) {
      setProblem('captcha_required');
      return;
    }
    submitted.current = true;
    setProblem(null);
    book.mutate(
      {
        slug,
        serviceId: service.id,
        slotStart: chosen,
        name: details.name,
        phoneE164: details.phoneE164,
        email: details.email,
        locale: i18n.language,
        captchaToken: siteKey ? captchaToken : null,
      },
      {
        // The booking exists either way: if the payment service can't be reached the guest still
        // lands on their appointment rather than a dead end.
        onSuccess: ({ token }) => {
          // Required answers are enforced here, not by book_appointment (F3): if the database
          // refuses them the guest fixes them on the next screen; the booking stands either way.
          if (details.answers === null) return afterBooking(token);
          setAnswers.mutate(
            { token, answers: details.answers },
            {
              onSuccess: () => afterBooking(token),
              onError: (error) =>
                setAnswering({
                  token,
                  queueId: service.queueId,
                  serviceId: service.id,
                  answers: details.answers ?? {},
                  error,
                }),
            },
          );
        },
        onError: (error) => {
          submitted.current = false;
          if (siteKey) {
            setCaptchaRound((r) => r + 1);
            setCaptchaToken(null);
          }
          const code = errorCode(error);
          setProblem(KNOWN_ERRORS.includes(code) ? code : 'unknown');
          if (code === 'slot_full' || code === 'slot_unavailable') {
            // Someone else got there first: show what is still open.
            setSlotStart(null);
            void availability.refresh();
          }
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6 py-4">
      <header>
        <h1 className="text-3xl font-bold">{t('book.title')}</h1>
        <p className="text-lg text-muted">{location.data.name}</p>
      </header>

      {problem && !chosen ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t(`book.error.${problem}` as 'book.error.unknown')}
        </p>
      ) : null}

      {bookable.length > 1 ? (
        <Select
          label={t('book.service')}
          value={service?.id ?? ''}
          onChange={(e) => {
            setServiceId(e.target.value || null);
            setSlotStart(null);
          }}
        >
          {service ? null : <option value="" />}
          {bookable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      ) : null}

      {service && !chosen ? <SlotPicker slots={slots} tz={tz} onPick={setSlotStart} /> : null}

      {!chosen ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted">{t('waitlist.prompt')}</p>
          <Button variant="secondary" onClick={() => setWaitlisting(true)}>
            {t('waitlist.join')}
          </Button>
        </div>
      ) : null}

      {service && chosen ? (
        <Suspense fallback={<Spinner label={t('book.loading')} />}>
          <DetailsForm
            queueId={service.queueId}
            serviceId={service.id}
            summary={t('book.summary', {
              service: service.name,
              when: formatWhen(chosen, tz, i18n.language),
            })}
            countryCode={location.data.countryCode}
            retentionDays={location.data.retentionDays}
            problem={problem}
            pending={book.isPending}
            onBack={() => setSlotStart(null)}
            onSubmit={submit}
          />
          {siteKey ? (
            <Turnstile
              siteKey={siteKey}
              language={i18n.language}
              round={captchaRound}
              label={t('book.captcha')}
              onToken={setCaptchaToken}
              onProblem={() => undefined}
            />
          ) : null}
        </Suspense>
      ) : null}
    </div>
  );
}
