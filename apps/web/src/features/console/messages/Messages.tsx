import { errorCode, formatLocalTime } from '@qm/domain';
import { Badge, Button, Spinner } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import {
  useRetryNotification,
  useTextStates,
  useVisitNotifications,
  type NotificationStatus,
  type TextState,
} from './api.ts';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const TONES: Record<string, Tone> = {
  queued: 'info',
  claimed: 'info',
  failed: 'warning',
  sent: 'success',
  delivered: 'success',
  suppressed: 'warning',
  dead: 'danger',
};
const TEXT_CHANNELS = new Set(['sms', 'whatsapp']);
const CHANNELS = new Set(['push', 'email', 'sms', 'whatsapp', 'telegram', 'console']);
const KNOWN_ERRORS = new Set([
  'no_consent',
  'suppressed',
  'quiet_hours',
  'bot_blocked',
  'no_channel',
  'recipient_deleted',
  'lease_expired',
  'hard_bounce',
  'complaint',
]);

/** Plain words for what a message's last error means to staff. */
export function useDeliveryReason() {
  const { t } = useTranslation('staff');
  return (n: NotificationStatus): string | null => {
    const code = n.last_error;
    if (!code) return null;
    if (KNOWN_ERRORS.has(code)) return t(`console.messages.reason.${code}` as never);
    return t(
      code.startsWith('http_') ? 'console.messages.reason.http' : 'console.messages.reason.other',
    );
  };
}

/** Texts on, no consent or opted out, beside a guest's name. Nothing for a guest with no number. */
export function TextBadge({ state }: { state: TextState | undefined }) {
  const { t } = useTranslation('staff');
  if (!state || state === 'none') return null;
  const tone = state === 'on' ? 'success' : state === 'opted_out' ? 'danger' : 'neutral';
  return (
    <Badge tone={tone} data-testid="text-badge" data-state={state}>
      {t(`console.texts.${state}` as never)}
    </Badge>
  );
}

/** The warning mark on a console row whose `called` message did not reach the guest. */
export function DeliveryWarning() {
  const { t } = useTranslation('staff');
  return (
    <Badge tone="danger" data-testid="delivery-warning">
      <span aria-hidden="true">⚠ </span>
      {t('console.messages.warning')}
    </Badge>
  );
}

export function ChannelLabel({ via }: { via: string | null }) {
  const { t } = useTranslation('staff');
  return <>{via && CHANNELS.has(via) ? t(`console.messages.channel.${via}` as never) : via}</>;
}

export function StatusBadge({ status }: { status: string | null }) {
  const { t } = useTranslation('staff');
  return (
    <Badge tone={TONES[status ?? ''] ?? 'neutral'}>
      {t(`console.messages.status.${status ?? 'unknown'}` as never)}
    </Badge>
  );
}

/**
 * The visit sheet's Messages timeline (N-12, #257): every message the system tried, with its
 * channel, status and, when it failed, why in plain words. Managers can retry a dead one.
 */
export function MessagesTimeline({
  visitId,
  timeZone,
  canRetry,
  textState,
}: {
  visitId: string;
  timeZone: string;
  canRetry: boolean;
  textState?: TextState;
}) {
  const { t } = useTranslation('staff');
  const list = useVisitNotifications(visitId);
  const retry = useRetryNotification();
  const reason = useDeliveryReason();
  // Staff cannot send a text to a guest who opted out or never agreed (3-CG10).
  const blocked = textState === 'opted_out' || textState === 'no_consent';
  if (list.isPending) return <Spinner label={t('console.messages.loading')} />;
  const rows = list.data ?? [];
  const retryError = retry.error ? errorCode(retry.error) : null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`messages-${visitId}`}>
      <h3 id={`messages-${visitId}`} className="font-medium">
        {t('console.messages.title')}
      </h3>
      {rows.length === 0 ? <p className="text-muted">{t('console.messages.none')}</p> : null}
      <ol className="flex flex-col gap-2">
        {rows.map((n) => (
          <li key={n.id} className="flex flex-wrap items-center gap-2" data-testid="message-row">
            <span className="font-medium">
              <ChannelLabel via={n.via} />
            </span>
            <StatusBadge status={n.status} />
            {n.created_at ? (
              <time dateTime={n.created_at} className="text-muted">
                {formatLocalTime(n.created_at, timeZone)}
              </time>
            ) : null}
            {reason(n) ? <span className="text-muted">{reason(n)}</span> : null}
            {canRetry && n.status === 'dead' ? (
              <>
                <Button
                  variant="secondary"
                  loading={retry.isPending}
                  disabled={blocked && TEXT_CHANNELS.has(n.via ?? '')}
                  aria-describedby={
                    blocked && TEXT_CHANNELS.has(n.via ?? '') ? `why-${n.id}` : undefined
                  }
                  onClick={() => retry.mutate(n.id!)}
                >
                  {t('console.messages.retry')}
                </Button>
                {blocked && TEXT_CHANNELS.has(n.via ?? '') ? (
                  <span id={`why-${n.id}`} className="text-sm text-muted">
                    {t(`console.texts.retryBlocked.${textState}` as never)}
                  </span>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {retryError ? (
        <p role="alert" className="text-sm font-medium text-danger-strong">
          {t(
            retryError === 'not_relevant'
              ? 'console.messages.notRelevant'
              : 'console.messages.retryFailed',
          )}
        </p>
      ) : null}
    </section>
  );
}

/** The timeline for the sheet: the location's zone and the signed-in role come from the session. */
export function MessagesSection({ visitId }: { visitId: string }) {
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const canRetry = org?.role === 'manager' || org?.role === 'admin' || org?.role === 'owner';
  const textState = useTextStates(location?.id).get(visitId);
  return (
    <MessagesTimeline
      visitId={visitId}
      timeZone={location?.tz ?? 'UTC'}
      canRetry={canRetry}
      textState={textState}
    />
  );
}
