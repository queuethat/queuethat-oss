import { Badge, Button, DataTable, EmptyState, Input, Select, Spinner, type Tone } from '@qm/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { deliveriesQuery, type Delivery } from './api.ts';
import { reasonOf } from './reasons.ts';

const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'telegram', 'webhook'];
const STATUSES = ['queued', 'claimed', 'sent', 'delivered', 'failed', 'dead', 'suppressed'];
/** What the all-businesses view may list: the database refuses anything but problems. */
const FAILURES = ['failed', 'dead', 'suppressed'];

const TONE: Record<string, Tone> = {
  sent: 'success',
  delivered: 'success',
  failed: 'danger',
  dead: 'danger',
  suppressed: 'warning',
  queued: 'neutral',
  claimed: 'neutral',
};

/** A `datetime-local` value (the viewer's own clock) as an ISO instant, or undefined when blank/invalid. */
function instant(local: string): string | undefined {
  const ms = local ? new Date(local).getTime() : NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Message and webhook deliveries (#1130) for one business, or failures across all of them when
 * `orgId` is null. Recipients arrive masked and no message body exists to show; times are in the
 * viewer's time zone. Reading it is logged by the database with the business id.
 */
export function DeliveryLog({ orgId }: { orgId: string | null }) {
  const { t, i18n } = useTranslation('platform');
  const [status, setStatus] = useState(orgId ? '' : 'failed');
  const [channel, setChannel] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const from = instant(fromLocal);
  const to = instant(toLocal);
  const badRange = from !== undefined && to !== undefined && from >= to;
  const log = useInfiniteQuery({
    ...deliveriesQuery({ orgId, status, medium: channel, from, to }),
    enabled: !badRange,
  });
  const time = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
  const rows = log.data?.pages.flat() ?? [];

  const explain = (row: Delivery) => {
    const reason = reasonOf(row);
    return reason
      ? t(`deliveries.reasons.${reason.key}` as 'deliveries.reasons.http', {
          status: reason.values.status ?? '',
          code: reason.values.code ?? '',
        })
      : '';
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">{t('deliveries.intro')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('deliveries.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {orgId ? <option value="">{t('deliveries.any')}</option> : null}
          {(orgId ? STATUSES : FAILURES).map((s) => (
            <option key={s} value={s}>
              {t(`deliveries.statuses.${s}` as 'deliveries.statuses.sent')}
            </option>
          ))}
        </Select>
        <Select
          label={t('deliveries.channel')}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value="">{t('deliveries.any')}</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {t(`deliveries.channels.${c}` as 'deliveries.channels.sms')}
            </option>
          ))}
        </Select>
        <Input
          type="datetime-local"
          label={t('deliveries.from')}
          value={fromLocal}
          onChange={(e) => setFromLocal(e.target.value)}
        />
        <Input
          type="datetime-local"
          label={t('deliveries.to')}
          value={toLocal}
          onChange={(e) => setToLocal(e.target.value)}
        />
      </div>
      {badRange ? <p role="alert">{t('deliveries.badRange')}</p> : null}

      {badRange ? null : log.isError ? (
        <EmptyState title={t('ops.loadFailed')} />
      ) : !log.data ? (
        <Spinner label={t('ops.loading')} />
      ) : (
        <>
          <DataTable
            label={t('deliveries.title')}
            scrollLabel={t('deliveries.title')}
            rows={rows}
            getRowKey={(r) => `${r.kind}:${r.id}`}
            empty={<EmptyState title={t('deliveries.empty')} />}
            columns={[
              {
                id: 'at',
                header: t('deliveries.at'),
                cell: (r) => time.format(new Date(r.created_at)),
              },
              ...(orgId
                ? []
                : [
                    {
                      id: 'org',
                      header: t('deliveries.org'),
                      cell: (r: Delivery) => (
                        <Link
                          to="/platform/orgs/$orgId"
                          params={{ orgId: r.org_id }}
                          className="underline"
                        >
                          {r.org_name}
                        </Link>
                      ),
                    },
                  ]),
              {
                id: 'channel',
                header: t('deliveries.channel'),
                cell: (r) =>
                  `${t(`deliveries.channels.${r.medium}` as 'deliveries.channels.sms', { defaultValue: r.medium })}${r.provider ? ` · ${r.provider}` : ''}`,
              },
              { id: 'trigger', header: t('deliveries.trigger'), cell: (r) => r.template_key },
              {
                id: 'to',
                header: t('deliveries.recipient'),
                cell: (r) => r.recipient_masked ?? t('deliveries.noRecipient'),
              },
              {
                id: 'status',
                header: t('deliveries.status'),
                cell: (r) => (
                  <Badge tone={TONE[r.status] ?? 'neutral'}>
                    {t(`deliveries.statuses.${r.status}` as 'deliveries.statuses.sent', {
                      defaultValue: r.status,
                    })}
                  </Badge>
                ),
              },
              { id: 'why', header: t('deliveries.why'), cell: explain },
              {
                id: 'attempts',
                header: t('deliveries.attempts'),
                cell: (r) => r.attempts,
                align: 'end',
              },
            ]}
          />
          {log.hasNextPage ? (
            <Button
              variant="secondary"
              loading={log.isFetchingNextPage}
              loadingLabel={t('ops.loading')}
              onClick={() => void log.fetchNextPage()}
            >
              {t('deliveries.more')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
