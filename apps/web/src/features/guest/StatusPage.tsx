import { appConfig } from '../../lib/config.ts';
import { errorCode, formatEta, type Translate } from '@qm/domain';
import {
  Card,
  ConfirmDestructive,
  ConnectionIndicator,
  EmptyState,
  Icon,
  iconWifiOff,
  LinkButton,
  Spinner,
  StatusPill,
  TicketNumber,
} from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { formatAsOf, isStale, useConnectionState } from '../../lib/live.ts';
import { QuietBoundary } from '../../components/QuietBoundary.tsx';
import { useNow } from '../../lib/now.ts';
import { useAlertSound } from '../../lib/sound.ts';
import {
  forgetVisit,
  groupMembers,
  lastJoinPage,
  read,
  useLeaveQueue,
  useVisitInfo,
  useVisitStatus,
  visitEnded,
} from './api.ts';
import { joinProvider } from './captcha/publicJoin.ts';
import { CalledTakeover, SoundGate } from './CalledAlert.tsx';

// Group tabs (only when several joined together), alert choices and push opt-in: loaded after the
// first paint, so they stay off the 150 KB route budget.
const LanguagePicker = lazy(() =>
  import('../i18n/LanguagePicker.tsx').then((m) => ({ default: m.LanguagePicker })),
);
const GroupTabs = lazy(() => import('./GroupTabs.tsx').then((m) => ({ default: m.GroupTabs })));
const Chat = lazy(() => import('./Chat.tsx').then((m) => ({ default: m.Chat })));
const Party = lazy(() => import('./Party.tsx').then((m) => ({ default: m.Party })));
const Feedback = lazy(() => import('./Feedback.tsx').then((m) => ({ default: m.Feedback })));
const AlertPrefs = lazy(() => import('./AlertPrefs.tsx').then((m) => ({ default: m.AlertPrefs })));
const TelegramOptIn = lazy(() =>
  import('./TelegramOptIn.tsx').then((m) => ({ default: m.TelegramOptIn })),
);
const PhoneVerify = lazy(() =>
  import('./PhoneVerify.tsx').then((m) => ({ default: m.PhoneVerify })),
);
const TextAlerts = lazy(() => import('./TextAlerts.tsx').then((m) => ({ default: m.TextAlerts })));
const PushOptIn = lazy(() => import('./PushOptIn.tsx').then((m) => ({ default: m.PushOptIn })));

// Below the fold and collapsed: its code (place card, QR, calendar) stays off the 150 KB route budget.
const VisitInfo = lazy(() => import('./VisitInfo.tsx').then((m) => ({ default: m.VisitInfo })));
// Only a guest staff asked to pay at the counter ever loads it (and Stripe with it).
const PosPay = lazy(() => import('./PosPay.tsx').then((m) => ({ default: m.PosPay })));
// The guest's own answers (on my way, need more time) and the arrive-by warning: also off the budget.
const UndoLeave = lazy(() => import('./UndoLeave.tsx').then((m) => ({ default: m.UndoLeave })));
const Snooze = lazy(() => import('./Snooze.tsx').then((m) => ({ default: m.Snooze })));

/**
 * `/v/:token` (G-1, G-2, G-13): ticket, place in line and wait estimate, live. Everything shown
 * comes from api.get_visit_status; the page never counts down or re-derives position or ETA.
 */
export function StatusPage({ token }: { token: string }) {
  const { t, i18n } = useTranslation('guest');
  const visit = useVisitStatus(token);
  const info = useVisitInfo(token);
  const connection = useConnectionState();
  const now = useNow(15_000);
  const status = visit.data?.status ?? null;
  const waiting = status === 'waiting';
  useWakeLock(waiting);
  const sound = useAlertSound();
  const ended = visitEnded(status ?? '');
  useEffect(() => {
    if (ended) forgetVisit(token);
  }, [ended, token]);

  if (visit.isPending) return <Spinner label={t('status.loading')} className="mx-auto my-16" />;
  if (!visit.data) {
    const missing = errorCode(visit.error) === 'not_found';
    return (
      <EmptyState
        title={t(missing ? 'status.notFound.title' : 'status.loadFailed.title')}
        description={t(missing ? 'status.notFound.body' : 'status.loadFailed.body')}
      />
    );
  }

  const v = visit.data;
  const stale = isStale(visit.dataUpdatedAt, now);
  const eta = waiting
    ? formatEta(v.eta_state, v.eta_low, v.eta_high, i18n.getFixedT(null, 'eta') as Translate)
    : null;
  const message = statusMessage(v, t, i18n.language);
  const offline = connection === 'offline';

  return (
    <div className="flex flex-col gap-5 py-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('status.title')}</h1>
          <p className="text-muted">
            {[v.location_name, v.queue_name].filter(Boolean).join(' · ')}
          </p>
          <QueueChangeAnnouncer queueName={v.queue_name} />
        </div>
        {ended ? null : (
          <ConnectionIndicator state={connection} label={t(`status.connection.${connection}`)} />
        )}
      </header>

      {groupMembers(token).length > 0 ? (
        <QuietBoundary>
          <Suspense fallback={<div className="min-h-target" aria-hidden />}>
            <GroupTabs token={token} current={v} panelId={PANEL_ID} />
          </Suspense>
        </QuietBoundary>
      ) : null}

      <Card
        id={PANEL_ID}
        role="tabpanel"
        className="flex flex-col items-center gap-3 py-8 text-center"
      >
        <p className="text-muted">{t('status.ticket')}</p>
        <TicketNumber
          ticket={v.display_ticket ?? ''}
          size="tv"
          className="text-[min(4rem,18vw)]!"
          data-testid="ticket"
        />
        {status ? (
          <StatusPill status={status}>
            {t(
              v.arrive_after && status === 'expected'
                ? 'status.state.scheduled'
                : `status.state.${status}`,
            )}
          </StatusPill>
        ) : null}
        <div aria-live="polite" className="flex flex-col gap-1">
          {waiting && v.position != null ? (
            <>
              <p className="text-2xl font-semibold" data-testid="position">
                {t('status.position', { count: v.position })}
              </p>
              <p className="text-muted">{t('status.ahead', { count: v.people_ahead ?? 0 })}</p>
            </>
          ) : null}
          {eta ? (
            <p className={stale ? 'text-muted opacity-60' : undefined} data-testid="eta">
              <span className="sr-only">{t('status.wait')}: </span>
              {eta}
            </p>
          ) : null}
        </div>
      </Card>

      {offline ? (
        <Card role="status" data-testid="offline" className="flex items-start gap-3">
          <Icon icon={iconWifiOff} size="md" />
          <div>
            <p className="font-semibold">{t('status.offline.title')}</p>
            <p className="text-muted">{t('status.offline.body')}</p>
          </div>
        </Card>
      ) : null}
      {stale ? (
        <p role="status" className="rounded-card bg-warning-soft p-3 text-warning-strong">
          {t('status.asOf', { time: v.as_of ? formatAsOf(v.as_of, i18n.language) : '' })}
        </p>
      ) : null}

      {message ? (
        <p aria-live="polite" className="text-center text-lg font-medium">
          {message}
        </p>
      ) : null}

      <CalledTakeover
        called={status === 'called'}
        callCount={v.call_count ?? 1}
        ticket={v.display_ticket ?? ''}
        counter={v.counter_label}
        sound={sound}
      >
        {waiting || status === 'called' ? (
          <QuietBoundary>
            <Suspense fallback={null}>
              <Snooze token={token} visit={v} />
            </Suspense>
          </QuietBoundary>
        ) : null}
      </CalledTakeover>

      {/* Still offered while called, so a recall can ring. */}
      {waiting || status === 'called' ? <SoundGate sound={sound} /> : null}
      {waiting || !ended ? (
        <QuietBoundary>
          <Suspense fallback={null}>
            {waiting && v.text_consent === 'off' && info.data?.location_name ? (
              <TextAlerts
                token={token}
                business={{ name: info.data.location_name, contact: info.data.phone ?? null }}
                locale={info.data.locale ?? 'en'}
              />
            ) : null}
            {waiting &&
            v.text_consent === 'on' &&
            ['pow', 'dev'].includes(joinProvider() ?? '') &&
            read(`qm:phone-verified:${token}`) !== '1' ? (
              <PhoneVerify token={token} />
            ) : null}
            {waiting ? <PushOptIn token={token} /> : null}
            {waiting && appConfig().telegramBot ? <TelegramOptIn token={token} /> : null}
            {ended ? null : <AlertPrefs token={token} />}
          </Suspense>
        </QuietBoundary>
      ) : null}
      {(waiting || status === 'called' || status === 'serving') && v.chat_version != null ? (
        <QuietBoundary>
          <Suspense fallback={null}>
            <Chat token={token} visit={v} />
          </Suspense>
        </QuietBoundary>
      ) : null}
      {waiting || status === 'called' ? (
        <QuietBoundary>
          <Suspense fallback={null}>
            <Party token={token} visit={v} />
          </Suspense>
        </QuietBoundary>
      ) : null}
      {status === 'called' || status === 'serving' || status === 'served' ? (
        <QuietBoundary>
          <PosPay token={token} />
        </QuietBoundary>
      ) : null}
      {status === 'served' ? (
        <QuietBoundary>
          <Suspense fallback={null}>
            <Feedback token={token} />
          </Suspense>
        </QuietBoundary>
      ) : null}
      {ended || !info.data ? null : (
        <QuietBoundary>
          <Suspense fallback={null}>
            <VisitInfo info={info.data} ticket={v.display_ticket ?? ''} />
          </Suspense>
        </QuietBoundary>
      )}

      {v.guest_actions?.includes('leave') ? <LeaveQueue token={token} /> : null}
      {v.guest_actions?.includes('undo_leave') ? (
        <QuietBoundary>
          <Suspense fallback={null}>
            <UndoLeave token={token} />
          </Suspense>
        </QuietBoundary>
      ) : null}
      {ended ? <JoinAgain /> : null}

      <QuietBoundary>
        <Suspense fallback={null}>
          <LanguagePicker />
        </Suspense>
      </QuietBoundary>
    </div>
  );
}

const PANEL_ID = 'visit-panel';

/** G5 (#55): leave the line, only when the database offers it, and only after a confirm (I-9). */
function LeaveQueue({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  const leave = useLeaveQueue(token);
  return (
    <div className="flex flex-col gap-2">
      <ConfirmDestructive
        triggerLabel={t('status.leave.trigger')}
        triggerVariant="secondary"
        title={t('status.leave.title')}
        description={t('status.leave.body')}
        confirmLabel={t('status.leave.confirm')}
        cancelLabel={t('status.leave.cancel')}
        onConfirm={() => leave.mutateAsync()}
      />
      {leave.isError ? (
        <p role="alert" className="text-center font-medium text-danger-strong">
          {t('status.leave.failed')}
        </p>
      ) : null}
    </div>
  );
}

/** After a visit ends, a way back to the poster page this browser joined from, if it knows one. */
function JoinAgain() {
  const { t } = useTranslation('guest');
  const slug = lastJoinPage();
  if (!slug) return null;
  return (
    <LinkButton
      variant="secondary"
      render={(p) => <Link to="/q/$locationSlug" params={{ locationSlug: slug }} {...p} />}
    >
      {t('status.joinAgain')}
    </LinkButton>
  );
}

/** The arrival time in the guest's own clock, with its zone name so it can't be misread. */
function formatArrival(at: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(at));
}

type Visit = NonNullable<ReturnType<typeof useVisitStatus>['data']>;

function statusMessage(
  v: Visit,
  t: ReturnType<typeof useTranslation<'guest'>>['t'],
  language: string,
) {
  const location = v.location_name ?? '';
  switch (v.status) {
    case 'called':
      return v.counter_label
        ? t('status.message.called', { counter: v.counter_label })
        : t('status.message.calledNoCounter');
    case 'serving':
      return t('status.message.serving');
    case 'served':
      return t('status.message.served', { location });
    case 'expired':
      return t('status.message.expired', { location });
    case 'no_show':
    case 'cancelled':
    case 'removed':
      return t(`status.message.${v.status}`);
    case 'expected':
      // A guest who joined for later (J-13) has a time, not an appointment.
      return v.arrive_after
        ? t('status.message.later', { time: formatArrival(v.arrive_after, language) })
        : t('status.message.expected');
    default:
      return null;
  }
}

/** Re-renders every `ms` so staleness shows without new data. */
/** Keeps the screen on while waiting, so the page (and its live updates) stays in front. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(
        (l) => (lock = l),
        () => {}, // denied (low battery, no gesture): the page still works
      );
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, [active]);
}

/**
 * Q-12: when a journey moves the guest to another queue, a screen reader hears where they are
 * now. Silent on first load and when the name is unchanged.
 */
function QueueChangeAnnouncer({ queueName }: { queueName: string | null }) {
  const { t } = useTranslation('guest');
  const first = useRef(queueName);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (queueName !== first.current) setChanged(true);
  }, [queueName]);
  return (
    <p role="status" className="sr-only">
      {changed && queueName ? t('status.nowIn', { queue: queueName }) : ''}
    </p>
  );
}
