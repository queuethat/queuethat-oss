import { Card } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { Database } from '@qm/db-types';

type Key = 'served' | 'left' | 'avgWait' | 'longestWait' | 'busiestHour';
type TodayStats = Database['api']['CompositeTypes']['today_stats'];

/**
 * "How today went": the figures an owner wants at close, all read from `api.today_stats` for the
 * location's service day. Only formatting happens here (hour in the location's time zone).
 * With nobody served yet it shows an empty state instead of five zeros.
 */
export function EndOfDayCard({ stats, timeZone }: { stats: TodayStats; timeZone: string }) {
  const { t, i18n } = useTranslation('admin');
  const minutes = (value: number | null) =>
    value == null ? t('today.noWaitYet') : t('today.minutes', { count: Number(value) });

  if (!stats.served) {
    return (
      <Card data-testid="end-of-day">
        <h2 className="text-lg font-semibold">{t('today.endOfDay.title')}</h2>
        <p className="mt-1 text-muted">{t('today.endOfDay.empty')}</p>
      </Card>
    );
  }
  const busiest = stats.busiest_hour
    ? new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', timeZone }).format(
        new Date(stats.busiest_hour),
      )
    : t('today.noWaitYet');
  const rows: [Key, string][] = [
    ['served', String(stats.served ?? 0)],
    [
      'left',
      t('today.endOfDay.leftValue', {
        noShows: stats.no_shows ?? 0,
        cancelled: stats.cancelled ?? 0,
      }),
    ],
    ['avgWait', minutes(stats.avg_wait_minutes)],
    ['longestWait', minutes(stats.longest_wait_minutes)],
    ['busiestHour', busiest],
  ];
  return (
    <Card data-testid="end-of-day">
      <h2 className="text-lg font-semibold">{t('today.endOfDay.title')}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-5">
        {rows.map(([key, value]) => (
          <div key={key} data-testid={`eod-${key}`}>
            <dt className="text-sm text-muted">{t(`today.endOfDay.${key}`)}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
