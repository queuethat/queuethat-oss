import { DataTable, EmptyState, PageHeader, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { deliverySummaryQuery } from './api.ts';
import { DeliveryLog } from './DeliveryLog.tsx';

const DAY_MS = 86_400_000;
const DAYS = 7;

/**
 * `/platform/messages` (#1130): messages and webhooks over the last 7 days by channel and
 * provider across every business (a Twilio or Resend problem shows as one failing row), then
 * the failures behind those numbers. Counts only; recipients stay masked.
 */
export function MessagesPage({ now: start }: { now?: number }) {
  const { t, i18n } = useTranslation('platform');
  // Fixed at first render so the query key, and the cache, stay stable.
  const [now] = useState(() => start ?? Date.now());
  const summary = useQuery(
    deliverySummaryQuery(new Date(now - DAYS * DAY_MS).toISOString(), new Date(now).toISOString()),
  );
  const number = new Intl.NumberFormat(i18n.language);
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 1,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('deliveries.page.title')} />
      <section aria-labelledby="delivery-summary" className="flex flex-col gap-3">
        <h2 id="delivery-summary" className="text-xl font-semibold">
          {t('deliveries.page.summary', { count: DAYS })}
        </h2>
        {summary.isError ? (
          <EmptyState title={t('ops.loadFailed')} />
        ) : !summary.data ? (
          <Spinner label={t('ops.loading')} />
        ) : (
          <DataTable
            label={t('deliveries.page.summary', { count: DAYS })}
            scrollLabel={t('deliveries.page.summary', { count: DAYS })}
            rows={summary.data}
            getRowKey={(r) => `${r.medium}:${r.provider}`}
            empty={<EmptyState title={t('deliveries.page.noTraffic')} />}
            columns={[
              {
                id: 'channel',
                header: t('deliveries.channel'),
                cell: (r) =>
                  t(`deliveries.channels.${r.medium}` as 'deliveries.channels.sms', {
                    defaultValue: r.medium,
                  }),
              },
              { id: 'provider', header: t('deliveries.provider'), cell: (r) => r.provider },
              {
                id: 'sent',
                header: t('deliveries.statuses.sent'),
                cell: (r) => number.format(r.sent),
                align: 'end',
              },
              {
                id: 'failed',
                header: t('deliveries.statuses.failed'),
                cell: (r) => number.format(r.failed),
                align: 'end',
              },
              {
                id: 'suppressed',
                header: t('deliveries.statuses.suppressed'),
                cell: (r) => number.format(r.suppressed),
                align: 'end',
              },
              {
                id: 'pending',
                header: t('deliveries.page.pending'),
                cell: (r) => number.format(r.pending),
                align: 'end',
              },
              {
                id: 'rate',
                header: t('deliveries.page.rate'),
                cell: (r) => percent.format(r.failure_rate),
                align: 'end',
              },
            ]}
          />
        )}
      </section>
      <section aria-labelledby="delivery-failures" className="flex flex-col gap-3">
        <h2 id="delivery-failures" className="text-xl font-semibold">
          {t('deliveries.page.failures')}
        </h2>
        <DeliveryLog orgId={null} />
      </section>
    </div>
  );
}
