import { BarChart, EmptyState, PageHeader, ScrollRegion, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { orgNamesQuery, platformStatsQuery } from './api.ts';
import { dailyTotals, lastDays, orgTotals, type Counts } from './summaries.ts';

const DAYS = 30;
const COLUMNS: (keyof Counts)[] = [
  'joins',
  'served',
  'no_shows',
  'cancelled',
  'notifications_sent',
  'notifications_failed',
];

/**
 * `/platform/stats` (PLT13, #419): the last 30 UTC days from the nightly rollup
 * (`api.platform_stats`), as a chart of joins and a table per org. Today fills in after 00:15 UTC
 * tomorrow, when the rollup runs.
 */
export function StatsPage({ now: start }: { now?: number }) {
  const { t, i18n } = useTranslation('platform');
  const [now] = useState(() => start ?? Date.now());
  const range = lastDays(DAYS, now);
  const stats = useQuery(platformStatsQuery(range.from, range.to));
  const names = useQuery(orgNamesQuery);
  if (!stats.data) {
    return stats.isError ? (
      <EmptyState title={t('ops.loadFailed')} />
    ) : (
      <Spinner label={t('ops.loading')} />
    );
  }
  const number = new Intl.NumberFormat(i18n.language);
  const dayLabel = new Intl.DateTimeFormat(i18n.language, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const days = dailyTotals(stats.data, range.days);
  const orgs = orgTotals(stats.data);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('ops.stats.title', { count: DAYS })} />
      <figure className="flex flex-col gap-2">
        <BarChart
          label={t('ops.stats.chart', { count: DAYS })}
          bars={days.map((d) => ({
            key: d.day,
            label: `${dayLabel.format(Date.parse(d.day))}: ${number.format(d.joins)}`,
            value: d.joins,
          }))}
        />
        <figcaption className="text-sm text-muted">{t('ops.stats.caption')}</figcaption>
        <table className="sr-only">
          <thead>
            <tr>
              <th scope="col">{t('ops.stats.day')}</th>
              <th scope="col">{t('ops.stats.columns.joins')}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <th scope="row">{dayLabel.format(Date.parse(d.day))}</th>
                <td>{number.format(d.joins)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
      <section aria-labelledby="stats-orgs" className="flex flex-col gap-2">
        <h2 id="stats-orgs" className="text-xl font-semibold">
          {t('ops.stats.perOrg')}
        </h2>
        {orgs.length === 0 ? (
          <EmptyState title={t('ops.stats.empty')} />
        ) : (
          <ScrollRegion label={t('ops.stats.title', { count: DAYS })}>
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th scope="col">{t('ops.stats.org')}</th>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col" className="text-right">
                      {t(`ops.stats.columns.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.orgId}>
                    <th scope="row" className="font-normal">
                      <Link
                        to="/platform/orgs/$orgId"
                        params={{ orgId: org.orgId }}
                        className="underline"
                      >
                        {names.data?.get(org.orgId) || org.orgId}
                      </Link>
                    </th>
                    {COLUMNS.map((c) => (
                      <td key={c} className="text-right">
                        {number.format(org[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </section>
    </div>
  );
}
