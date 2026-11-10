import { Button, Input, PageHeader, ScrollRegion, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { field, isoDay } from '../analytics/csv.ts';
import { comparisonQuery, type ComparisonRow } from './api.ts';

const COLS = [
  'name',
  'visits',
  'avgWaitMin',
  'avgServiceMin',
  'medianServiceMin',
  'noShowPct',
  'abandonmentPct',
  'withinEtaPct',
  'avgRating',
] as const;
type Col = (typeof COLS)[number];
/** Which direction is better for a column; visits and names carry no judgement. */
const BETTER: Partial<Record<Col, 'low' | 'high'>> = {
  avgWaitMin: 'low',
  avgServiceMin: 'low',
  medianServiceMin: 'low',
  abandonmentPct: 'low',
  avgRating: 'high',
  noShowPct: 'low',
  withinEtaPct: 'high',
};
const dash = (v: number | null) => (v === null ? '–' : String(v));

function sorted(rows: ComparisonRow[], key: Col, dir: 'asc' | 'desc') {
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

/** 'best' or 'worst' for a row in a column, only when the locations actually differ. */
function mark(rows: ComparisonRow[], col: Col, row: ComparisonRow): 'best' | 'worst' | null {
  const better = BETTER[col];
  if (!better || rows.length < 2) return null;
  const values = rows.map((r) => r[col]).filter((v): v is number => typeof v === 'number');
  const mine = row[col];
  if (typeof mine !== 'number' || new Set(values).size < 2) return null;
  const best = better === 'low' ? Math.min(...values) : Math.max(...values);
  const worst = better === 'low' ? Math.max(...values) : Math.min(...values);
  return mine === best ? 'best' : mine === worst ? 'worst' : null;
}

/**
 * `/admin/comparison` (2B-R6, #297): the org's locations side by side. The page renders
 * `api.location_comparison` and derives no figure; best and worst are text, not colour.
 */
export function ComparisonPage() {
  const { t } = useTranslation('admin');
  const org = useCurrentOrg();
  const [range, setRange] = useState({ from: isoDay(30), to: isoDay() });
  const [sort, setSort] = useState<{ key: Col; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const stats = useQuery({
    ...comparisonQuery(org?.id ?? '', range.from, range.to),
    enabled: !!org && range.from <= range.to,
  });
  if (!org) return <Skeleton label={t('comparison.loading')} rows={2} />;
  const rows = sorted(stats.data ?? [], sort.key, sort.dir);

  function download() {
    const header = COLS.map((k) => field(t(`comparison.col.${k}`))).join(',');
    const lines = rows.map((r) => COLS.map((k) => field(r[k])).join(','));
    const url = URL.createObjectURL(
      new Blob([[header, ...lines].join('\r\n') + '\r\n'], { type: 'text/csv' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `comparison-${range.from}-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-6 pb-8">
      <PageHeader title={t('comparison.title')} />
      <div className="grid gap-4 sm:grid-cols-2">
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
          {t('comparison.error')}
        </p>
      ) : stats.isPending ? (
        <Skeleton label={t('comparison.loading')} rows={3} />
      ) : rows.length === 0 ? (
        <p>{t('comparison.empty')}</p>
      ) : (
        <>
          <div>
            <Button variant="secondary" onClick={download}>
              {t('analytics.csv')}
            </Button>
          </div>
          <ScrollRegion label={t('comparison.title')} className="min-w-0">
            <table className="w-full text-left">
              <caption className="sr-only">{t('comparison.title')}</caption>
              <thead>
                <tr>
                  {COLS.map((k) => (
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
                            dir: sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc',
                          })
                        }
                      >
                        {t(`comparison.col.${k}`)}
                      </Button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <th scope="row" className="p-2 font-normal">
                      {r.name}
                    </th>
                    {COLS.slice(1).map((k) => {
                      const m = mark(rows, k, r);
                      return (
                        <td key={k} className="p-2">
                          {dash(r[k as Exclude<Col, 'name'>])}
                          {m ? (
                            <span className="ml-2 text-sm">({t(`comparison.${m}`)})</span>
                          ) : null}
                        </td>
                      );
                    })}
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
