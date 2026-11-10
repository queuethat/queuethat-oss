import { BarChart, Button, Input, PageHeader, ScrollRegion, Select, Skeleton, Tabs } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useNoVisitsYet } from '../dashboard/setup/api.ts';
import { useCurrentLocation } from '../../auth/current.ts';
import { queuesQuery } from '../queues/api.ts';
import { queueServicesQuery } from '../services/api.ts';
import { analyticsQuery, type AnalyticsRow, type Bucket } from './api.ts';
import { isoDay, joinsByHour, toCsv } from './csv.ts';

const COLS = ['bucket', 'joined', 'served', 'wait50', 'wait90', 'abandon', 'noShow'] as const;
const PRESETS = ['7', '30', '90', 'custom'] as const;
const percent = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const dash = (v: number | null) => (v === null ? '–' : String(v));

/**
 * `/admin/analytics` (2P-RPT3, #199): wait, throughput, abandonment and no-show for a range.
 * Every chart has the same numbers in a table; the page renders database figures and derives none.
 */
export function AnalyticsPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const noVisits = useNoVisitsYet();
  const panelId = useId();
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>('30');
  const [custom, setCustom] = useState({ from: isoDay(30), to: isoDay() });
  const [bucket, setBucket] = useState<Bucket>('day');
  const [queueId, setQueueId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const range = preset === 'custom' ? custom : { from: isoDay(Number(preset)), to: isoDay() };
  const locationId = location?.id ?? '';
  const queues = useQuery({ ...queuesQuery(locationId), enabled: !!locationId });
  const services = useQuery({ ...queueServicesQuery(queueId), enabled: !!queueId });
  const stats = useQuery({
    ...analyticsQuery({ locationId, ...range, bucket, queueId, serviceId }),
    enabled: !!locationId && range.from <= range.to,
  });
  if (!location) return <Skeleton label={t('analytics.loading')} rows={2} />;
  const rows = stats.data ?? [];
  const headers = COLS.map((k) => t(`analytics.col.${k}`));

  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(headers, rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics-${range.from}-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('analytics.title')} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Select
          label={t('analytics.range')}
          value={preset}
          onChange={(e) => setPreset(e.target.value as (typeof PRESETS)[number])}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(`analytics.preset.${p}`)}
            </option>
          ))}
        </Select>
        {preset === 'custom' ? (
          <>
            <Input
              label={t('analytics.from')}
              type="date"
              value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <Input
              label={t('analytics.to')}
              type="date"
              value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </>
        ) : null}
        <Select
          label={t('analytics.bucket')}
          value={bucket}
          onChange={(e) => setBucket(e.target.value as Bucket)}
        >
          <option value="day">{t('analytics.byDay')}</option>
          <option value="hour">{t('analytics.byHour')}</option>
        </Select>
        <Select
          label={t('analytics.queue')}
          value={queueId}
          onChange={(e) => {
            setQueueId(e.target.value);
            setServiceId('');
          }}
        >
          <option value="">{t('analytics.all')}</option>
          {queues.data?.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </Select>
        <Select
          label={t('analytics.service')}
          value={serviceId}
          disabled={!queueId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">{t('analytics.all')}</option>
          {services.data?.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      {range.from > range.to ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('analytics.badRange')}
        </p>
      ) : stats.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('analytics.error')}
        </p>
      ) : stats.isPending ? (
        <Skeleton label={t('analytics.loading')} rows={3} />
      ) : rows.length === 0 ? (
        noVisits ? (
          <ScreenEmpty kind="analytics" />
        ) : (
          <p>{t('analytics.empty')}</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Tabs
              label={t('analytics.view')}
              panelId={panelId}
              value={view}
              onChange={(v) => setView(v as 'chart' | 'table')}
              items={[
                { id: 'chart', label: t('analytics.chart') },
                { id: 'table', label: t('analytics.table') },
              ]}
            />
            <Button variant="secondary" onClick={download}>
              {t('analytics.csv')}
            </Button>
          </div>
          <div id={panelId} role="tabpanel">
            {view === 'chart' ? <Charts rows={rows} bucket={bucket} /> : <DataTable rows={rows} />}
          </div>
        </>
      )}
    </div>
  );
}

function Charts({ rows, bucket }: { rows: AnalyticsRow[]; bucket: Bucket }) {
  const { t } = useTranslation('admin');
  const series: [
    (typeof COLS)[number],
    (r: AnalyticsRow) => number | null,
    (v: number) => string,
  ][] = [
    ['joined', (r) => r.joined, String],
    ['wait50', (r) => r.p50WaitMin, String],
    ['wait90', (r) => r.p90WaitMin, String],
    ['abandon', (r) => r.abandonment, (v) => percent(v)],
    ['noShow', (r) => r.noShow, (v) => percent(v)],
  ];
  const hours = joinsByHour(rows);
  const peak = Math.max(1, ...hours);
  return (
    <div className="flex flex-col gap-6">
      {series.map(([key, pick, show]) => (
        <section key={key}>
          <h2 className="font-medium">{t(`analytics.col.${key}`)}</h2>
          <BarChart
            label={t('analytics.chartLabel', { metric: t(`analytics.col.${key}`) })}
            bars={rows.map((r) => ({
              key: r.key,
              label: `${r.label}: ${show(pick(r) ?? 0)}`,
              value: pick(r) ?? 0,
            }))}
          />
        </section>
      ))}
      {bucket === 'hour' ? (
        <section>
          <h2 className="font-medium">{t('analytics.busiest')}</h2>
          <ol
            data-testid="heatmap"
            className="mt-2 grid grid-cols-4 gap-1 sm:grid-cols-6 lg:grid-cols-12"
          >
            {hours.map((n, h) => (
              <li
                key={h}
                className="rounded-control border border-border p-2 text-center"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round((n / peak) * 35)}%, transparent)`,
                }}
              >
                <span className="block text-sm">{String(h).padStart(2, '0')}:00</span>
                <span className="font-semibold">{n}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function DataTable({ rows }: { rows: AnalyticsRow[] }) {
  const { t } = useTranslation('admin');
  return (
    <ScrollRegion label={t('analytics.title')}>
      <table className="w-full text-left">
        <caption className="sr-only">{t('analytics.title')}</caption>
        <thead>
          <tr>
            {COLS.map((c) => (
              <th key={c} scope="col" className="p-2">
                {t(`analytics.col.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <th scope="row" className="p-2 font-normal">
                {r.label}
              </th>
              <td className="p-2">{r.joined}</td>
              <td className="p-2">{r.served}</td>
              <td className="p-2">{dash(r.p50WaitMin)}</td>
              <td className="p-2">{dash(r.p90WaitMin)}</td>
              <td className="p-2">{percent(r.abandonment)}</td>
              <td className="p-2">{percent(r.noShow)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
