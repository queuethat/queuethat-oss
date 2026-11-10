import { Input, PageHeader, ScrollRegion, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useCurrentLocation } from '../../auth/current.ts';
import { useNoVisitsYet } from '../dashboard/setup/api.ts';
import { isoDay } from '../analytics/csv.ts';
import { etaAccuracyQuery, type EtaAccuracyRow, type EtaGroup } from './api.ts';
import { headline } from './headline.ts';

const COLS = ['service', 'visits', 'within', 'early', 'late', 'bias', 'excluded'] as const;
const dash = (v: number | null) => (v === null ? '–' : String(v));

function Bar({ row, label }: { row: EtaAccuracyRow; label: string }) {
  const { t } = useTranslation('admin');
  const parts = [
    {
      key: 'early',
      pct: row.earlyPct ?? 0,
      cls: 'bg-info-soft',
      text: t('etaAccuracy.bar.early', { pct: row.earlyPct ?? 0 }),
    },
    {
      key: 'within',
      pct: row.withinPct ?? 0,
      cls: 'bg-state-serving-edge',
      text: t('etaAccuracy.bar.within', { pct: row.withinPct ?? 0 }),
    },
    {
      key: 'late',
      pct: row.latePct ?? 0,
      cls: 'bg-state-called-edge',
      text: t('etaAccuracy.bar.late', { pct: row.latePct ?? 0 }),
    },
  ];
  return (
    <li className="flex flex-col gap-1">
      <span className="text-sm">
        {label}: {parts.map((p) => p.text).join(' · ')}
      </span>
      <div
        className="flex h-4 w-full overflow-hidden rounded border border-border bg-surface"
        aria-hidden="true"
      >
        {parts.map((p) => (
          <div key={p.key} className={p.cls} style={{ width: `${p.pct}%` }} />
        ))}
      </div>
    </li>
  );
}

/**
 * `/admin/eta-accuracy` (2B-W3, #291): how often guests were called within the quoted range. The
 * database classifies visits (`api.eta_accuracy`); this page renders its rows and sums them for
 * the headline sentence.
 */
export function EtaAccuracyPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const noVisits = useNoVisitsYet();
  const [range, setRange] = useState({ from: isoDay(30), to: isoDay() });
  const locationId = location?.id ?? '';
  const enabled = !!locationId && range.from <= range.to;
  const days = useQuery({
    ...etaAccuracyQuery({ locationId, ...range, group: 'day' as EtaGroup }),
    enabled,
  });
  const services = useQuery({
    ...etaAccuracyQuery({ locationId, ...range, group: 'service' as EtaGroup }),
    enabled,
  });
  if (!location) return <Skeleton label={t('etaAccuracy.loading')} rows={2} />;
  const sum = days.data ? headline(days.data) : null;

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('etaAccuracy.title')} />
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
      ) : days.isError || services.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('etaAccuracy.error')}
        </p>
      ) : days.isPending || services.isPending ? (
        <Skeleton label={t('etaAccuracy.loading')} rows={3} />
      ) : !sum ? (
        noVisits ? (
          <ScreenEmpty kind="analytics" />
        ) : (
          <p>{t('etaAccuracy.empty')}</p>
        )
      ) : (
        <>
          <p className="text-lg" data-testid="eta-headline">
            {t('etaAccuracy.headline', { pct: sum.withinPct })}{' '}
            {sum.avgLateMin !== null && t('etaAccuracy.headlineLate', { min: sum.avgLateMin })}
          </p>
          <p>
            <Link to="/admin/queues" className="text-primary underline">
              {t('etaAccuracy.settings')}
            </Link>
          </p>
          <section aria-labelledby="eta-days">
            <h2 id="eta-days" className="mb-2 text-xl font-semibold">
              {t('etaAccuracy.perDay')}
            </h2>
            <ul className="flex flex-col gap-3">
              {days.data
                .filter((r) => r.visits > 0)
                .map((r) => (
                  <Bar key={r.group} row={r} label={r.group} />
                ))}
            </ul>
          </section>
          <section aria-labelledby="eta-services">
            <h2 id="eta-services" className="mb-2 text-xl font-semibold">
              {t('etaAccuracy.perService')}
            </h2>
            <ScrollRegion label={t('etaAccuracy.perService')}>
              <table className="w-full text-left">
                <caption className="sr-only">{t('etaAccuracy.perService')}</caption>
                <thead>
                  <tr>
                    {COLS.map((k) => (
                      <th key={k} scope="col" className="p-2">
                        {t(`etaAccuracy.col.${k}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {services.data.map((r) => (
                    <tr key={r.group} className="border-t border-border">
                      <th scope="row" className="p-2 font-normal">
                        {r.group || t('etaAccuracy.noService')}
                      </th>
                      <td className="p-2">{r.visits}</td>
                      <td className="p-2">{dash(r.withinPct)}</td>
                      <td className="p-2">{dash(r.earlyPct)}</td>
                      <td className="p-2">{dash(r.latePct)}</td>
                      <td className="p-2">{dash(r.biasMin)}</td>
                      <td className="p-2">{r.excludedNoQuote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </section>
        </>
      )}
    </div>
  );
}
