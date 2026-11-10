import { errorCode, formatLocalTime } from '@qm/domain';
import { Button, EmptyState, PageHeader, Skeleton } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { ChannelLabel, StatusBadge, useDeliveryReason } from '../../console/messages/Messages.tsx';
import { useFailedNotifications, useRetryNotification } from '../../console/messages/api.ts';

/**
 * `/admin/notifications/failed` (N-12, #257): the location's failed, dead and suppressed messages of
 * the last day, with a retry for dead ones (managers and above). The database refuses a retry whose
 * moment has passed (`not_relevant`).
 */
export function FailedMessages() {
  const { t } = useTranslation('staff');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const failed = useFailedNotifications(location?.id);
  const retry = useRetryNotification();
  const reason = useDeliveryReason();
  const canRetry = org?.role === 'manager' || org?.role === 'admin' || org?.role === 'owner';
  const retryError = retry.error ? errorCode(retry.error) : null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('console.messages.failedTitle')}
        description={t('console.messages.failedIntro')}
      />
      {failed.isPending ? <Skeleton label={t('console.messages.loading')} rows={3} /> : null}
      {failed.data && failed.data.length === 0 ? (
        <EmptyState title={t('console.messages.failedNone')} />
      ) : null}
      <ul className="flex flex-col gap-2">
        {(failed.data ?? []).map((n) => (
          <li
            key={n.id}
            className="flex flex-wrap items-center gap-2 rounded-card border border-border p-3"
            data-testid="failed-row"
          >
            <span className="font-medium">
              <ChannelLabel via={n.via} />
            </span>
            <StatusBadge status={n.status} />
            {n.created_at ? (
              <time dateTime={n.created_at} className="text-muted">
                {formatLocalTime(n.created_at, location?.tz ?? 'UTC')}
              </time>
            ) : null}
            {reason(n) ? <span className="text-muted">{reason(n)}</span> : null}
            {canRetry && n.status === 'dead' ? (
              <Button
                variant="secondary"
                loading={retry.isPending}
                onClick={() => retry.mutate(n.id!)}
              >
                {t('console.messages.retry')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {retryError ? (
        <p role="alert" className="text-sm font-medium text-danger-strong">
          {t(
            retryError === 'not_relevant'
              ? 'console.messages.notRelevant'
              : 'console.messages.retryFailed',
          )}
        </p>
      ) : null}
    </div>
  );
}
