import { PageHeader, ScrollRegion, Select, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useCurrentLocation } from '../../auth/current.ts';
import { useNoVisitsYet } from '../dashboard/setup/api.ts';
import { heatmapQuery, type HeatCell } from './api.ts';

const METRICS = ['avgArrivals', 'avgWaitMin', 'suggestedStaff'] as const;
type Metric = (typeof METRICS)[number];
const WEEKS = ['4', '8', '12', '26'] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Flag for an hour with fewer people scheduled than suggested; the legend and screen-reader text name it. */
const MARK = ' ▲';
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * `/admin/heatmap` (2B-R4, #295): weekday by hour. Every cell prints its number, so colour is
 * never the only signal; the grid is a real table, which is also the screen-reader view.
 */
export function HeatmapPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const noVisits = useNoVisitsYet();
  const [metric, setMetric] = useState<Metric>('avgArrivals');
  const [weeks, setWeeks] = useState<(typeof WEEKS)[number]>('8');
  const locationId = location?.id ?? '';
  const cells = useQuery({
    ...heatmapQuery(locationId, Number(weeks)),
    enabled: !!locationId,
  });
  if (!location) return <Skeleton label={t('heatmap.loading')} rows={2} />;

  const byKey = new Map((cells.data ?? []).map((c) => [`${c.dow}-${c.hour}`, c]));
  const value = (c: HeatCell | undefined) => c?.[metric] ?? null;
  const peak = Math.max(1, ...(cells.data ?? []).map((c) => value(c) ?? 0));

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('heatmap.title')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label={t('heatmap.metric')}
          value={metric}
          onChange={(e) => setMetric(e.target.value as Metric)}
        >
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {t(`heatmap.metrics.${m}`)}
            </option>
          ))}
        </Select>
        <Select
          label={t('heatmap.weeks')}
          value={weeks}
          onChange={(e) => setWeeks(e.target.value as (typeof WEEKS)[number])}
        >
          {WEEKS.map((w) => (
            <option key={w} value={w}>
              {t('heatmap.lastWeeks', { count: Number(w) })}
            </option>
          ))}
        </Select>
      </div>
      {cells.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('heatmap.error')}
        </p>
      ) : cells.isPending ? (
        <Skeleton label={t('heatmap.loading')} rows={3} />
      ) : cells.data.length === 0 ? (
        noVisits ? (
          <ScreenEmpty kind="analytics" />
        ) : (
          <p>{t('heatmap.empty')}</p>
        )
      ) : (
        <ScrollRegion label={t(`heatmap.metrics.${metric}`)}>
          <table data-testid="peak-heatmap" className="w-full text-center text-sm">
            <caption className="sr-only">{t(`heatmap.metrics.${metric}`)}</caption>
            <thead>
              <tr>
                <td />
                {HOURS.map((h) => (
                  <th key={h} scope="col" className="p-1 font-normal">
                    {String(h).padStart(2, '0')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((d) => (
                <tr key={d}>
                  <th scope="row" className="p-1 text-left font-normal">
                    {t(`heatmap.day.${d}`)}
                  </th>
                  {HOURS.map((h) => {
                    const cell = byKey.get(`${d}-${h}`);
                    const v = value(cell);
                    const short =
                      metric === 'suggestedStaff' &&
                      cell?.scheduledStaff != null &&
                      cell.scheduledStaff < cell.suggestedStaff;
                    return (
                      <td
                        key={h}
                        className="min-w-9 border border-border p-1"
                        style={{
                          backgroundColor:
                            v === null
                              ? undefined
                              : `color-mix(in srgb, var(--color-primary) ${Math.round((v / peak) * 35)}%, transparent)`,
                        }}
                      >
                        {v === null ? '' : v}
                        {short ? (
                          <>
                            <span aria-hidden="true">{MARK}</span>
                            <span className="sr-only">
                              {t('heatmap.understaffed', { scheduled: cell.scheduledStaff })}
                            </span>
                          </>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {metric === 'suggestedStaff' ? <p className="text-sm">{t('heatmap.legend')}</p> : null}
    </div>
  );
}
