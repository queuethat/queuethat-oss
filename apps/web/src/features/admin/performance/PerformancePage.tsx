import { Button, Input, PageHeader, ScrollRegion, Select, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useCurrentLocation } from '../../auth/current.ts';
import { useNoVisitsYet } from '../dashboard/setup/api.ts';
import { field, isoDay } from '../analytics/csv.ts';
import { performanceQuery, type PerformanceGroup, type PerformanceRow } from './api.ts';

const SORTS = ['label', 'served', 'avgServiceMin', 'avgCallToStartMin', 'noShows'] as const;
type SortKey = (typeof SORTS)[number];

const dash = (v: number | null) => (v === null ? '–' : String(v));

function sorted(rows: PerformanceRow[], key: SortKey, dir: 'asc' | 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sign;
  });
}

/**
 * `/admin/performance` (2B-R2, #293): served counts and times per staff member or counter. The
 * database returns only the rows the caller may see; the page renders them and derives nothing.
 */
export function PerformancePage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const noVisits = useNoVisitsYet();
  const [by, setBy] = useState<PerformanceGroup>('staff');
  const [range, setRange] = useState({ from: isoDay(30), to: isoDay() });
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'served',
    dir: 'desc',
  });
  const locationId = location?.id ?? '';
  const stats = useQuery({
    ...performanceQuery({ locationId, ...range, by }),
    enabled: !!locationId && range.from <= range.to,
  });
  if (!location) return <Skeleton label={t('performance.loading')} rows={2} />;
  const rows = sorted(stats.data ?? [], sort.key, sort.dir);

  function download() {
    const header = SORTS.map((k) => field(t(`performance.col.${k}`))).join(',');
    const lines = rows.map((r) => SORTS.map((k) => field(r[k])).join(','));
    const csv = [header, ...lines].join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `performance-${by}-${range.from}-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('performance.title')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Select
          label={t('performance.by')}
          value={by}
          onChange={(e) => setBy(e.target.value as PerformanceGroup)}
        >
          <option value="staff">{t('performance.byStaff')}</option>
          <option value="counter">{t('performance.byCounter')}</option>
        </Select>
        <Input
          label={t('analytics.from')}
          type="date"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
        <Input
          label={t('analytics.to')}
          type="date"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
        />
      </div>
      {range.from > range.to ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('analytics.badRange')}
        </p>
      ) : stats.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('performance.error')}
        </p>
      ) : stats.isPending ? (
        <Skeleton label={t('performance.loading')} rows={3} />
      ) : rows.length === 0 ? (
        noVisits ? (
          <ScreenEmpty kind="analytics" />
        ) : (
          <p>{t('performance.empty')}</p>
        )
      ) : (
        <>
          <div>
            <Button variant="secondary" onClick={download}>
              {t('analytics.csv')}
            </Button>
          </div>
          <ScrollRegion label={t('performance.title')}>
            <table className="w-full text-left">
              <caption className="sr-only">{t('performance.title')}</caption>
              <thead>
                <tr>
                  {SORTS.map((k) => (
                    <th
                      key={k}
                      scope="col"
                      aria-sort={
                        sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                      className="p-1"
                    >
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setSort({
                            key: k,
                            dir: sort.key === k && sort.dir === 'desc' ? 'asc' : 'desc',
                          })
                        }
                      >
                        {t(`performance.col.${k}`)}
                      </Button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <th scope="row" className="p-2 font-normal">
                      {r.label}
                    </th>
                    <td className="p-2">{r.served}</td>
                    <td className="p-2">{dash(r.avgServiceMin)}</td>
                    <td className="p-2">{dash(r.avgCallToStartMin)}</td>
                    <td className="p-2">{r.noShows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </>
      )}
    </div>
  );
}
