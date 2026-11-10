import {
  BarChart,
  Button,
  Checkbox,
  Input,
  PageHeader,
  ScrollRegion,
  Select,
  Skeleton,
  Spinner,
  useToast,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';
import { isoDay } from '../../analytics/csv.ts';
import {
  DIMENSIONS,
  MEASURES,
  runReportQuery,
  savedReportsQuery,
  useSaveReport,
  type Dimension,
  type Measure,
  type ReportDefinition,
  type ReportRow,
} from './api.ts';
import { reportCsv } from './csv.ts';

const canBuild = (role: string | undefined) =>
  role === 'manager' || role === 'admin' || role === 'owner';

/** `/admin/reports/custom` (4-RPT2, #393): pick measures, dimensions and dates, see the table and chart, save and download. */
export function CustomReportPage() {
  const { t } = useTranslation('admin-reports');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('custom.title')} />
      {canBuild(org.role) ? (
        <Builder orgId={org.id} />
      ) : (
        <p className="text-muted">{t('custom.managersOnly')}</p>
      )}
    </div>
  );
}

function Builder({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-reports');
  const toast = useToast();
  const { location } = useCurrentLocation();
  const [measures, setMeasures] = useState<Measure[]>(['visits', 'served']);
  const [dimensions, setDimensions] = useState<Dimension[]>(['weekday']);
  const [allLocations, setAllLocations] = useState(false);
  const [range, setRange] = useState({ from: isoDay(28), to: isoDay() });
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState<{ d: ReportDefinition; from: string; to: string }>();
  const saved = useQuery(savedReportsQuery(orgId));
  const save = useSaveReport(orgId);

  const definition: ReportDefinition = {
    measures,
    dimensions,
    ...(allLocations || !location ? {} : { locationId: location.id }),
  };
  const result = useQuery({
    ...runReportQuery(
      orgId,
      submitted?.d ?? definition,
      submitted?.from ?? '',
      submitted?.to ?? '',
    ),
    enabled: !!submitted,
  });
  const toggle = <T extends string>(list: T[], set: (v: T[]) => void, item: T) =>
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const valid = measures.length > 0 && dimensions.length <= 3 && range.from <= range.to;
  const rows = result.data ?? [];

  const cell = (r: ReportRow, d: Dimension) => {
    const v = r.dims[d];
    return d === 'weekday' ? t(`weekdays.${v}` as 'weekdays.1') : String(v ?? '');
  };
  const num = (r: ReportRow, m: Measure) => r.measures[m] ?? null;
  const headers = Object.fromEntries(
    [...DIMENSIONS, ...MEASURES].map((k) => [k, t(`custom.field.${k}`)]),
  );

  function download() {
    const csv = reportCsv(rows, headers, cell);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${submitted?.from}-${submitted?.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      {saved.data && saved.data.length > 0 ? (
        <Select
          label={t('custom.load')}
          value=""
          onChange={(e) => {
            const r = saved.data.find((s) => s.id === e.target.value);
            if (!r) return;
            setMeasures(r.measures);
            setDimensions(r.dimensions);
            setAllLocations(!r.locationId);
            setName(r.name);
          }}
        >
          <option value="">{t('custom.loadPlaceholder')}</option>
          {saved.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('custom.measures')}</legend>
          {MEASURES.map((m) => (
            <Checkbox
              key={m}
              label={t(`custom.field.${m}`)}
              checked={measures.includes(m)}
              onChange={() => toggle(measures, setMeasures, m)}
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('custom.dimensions')}</legend>
          {DIMENSIONS.map((d) => (
            <Checkbox
              key={d}
              label={t(`custom.field.${d}`)}
              checked={dimensions.includes(d)}
              disabled={!dimensions.includes(d) && dimensions.length >= 3}
              onChange={() => toggle(dimensions, setDimensions, d)}
            />
          ))}
        </fieldset>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t('custom.from')}
          type="date"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
        <Input
          label={t('custom.to')}
          type="date"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
        />
      </div>
      <Checkbox
        label={t('custom.allLocations')}
        checked={allLocations}
        onChange={(e) => setAllLocations(e.target.checked)}
      />
      {!valid ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('custom.invalid')}
        </p>
      ) : null}
      <div>
        <Button
          disabled={!valid}
          onClick={() => setSubmitted({ d: definition, from: range.from, to: range.to })}
        >
          {t('custom.run')}
        </Button>
      </div>

      {result.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {t('custom.error')}
        </p>
      ) : result.isFetching ? (
        <Spinner label={t('loading')} />
      ) : submitted && rows.length === 0 ? (
        <p>{t('custom.empty')}</p>
      ) : submitted ? (
        <section className="flex flex-col gap-4" aria-label={t('custom.results')}>
          <BarChart
            label={t('custom.chartLabel', {
              metric: t(`custom.field.${submitted.d.measures[0]!}`),
            })}
            bars={rows.map((r, i) => ({
              key: String(i),
              label: `${submitted.d.dimensions.map((d) => cell(r, d)).join(' / ')}: ${num(r, submitted.d.measures[0]!) ?? 0}`,
              value: num(r, submitted.d.measures[0]!) ?? 0,
            }))}
          />
          <ScrollRegion label={t('custom.results')}>
            <table className="w-full text-left" data-testid="report-table">
              <thead>
                <tr>
                  {[...submitted.d.dimensions, ...submitted.d.measures].map((k) => (
                    <th key={k} scope="col" className="p-2">
                      {t(`custom.field.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    {submitted.d.dimensions.map((d) => (
                      <td key={d} className="p-2">
                        {cell(r, d)}
                      </td>
                    ))}
                    {submitted.d.measures.map((m) => (
                      <td key={m} className="p-2">
                        {num(r, m) ?? '–'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <div>
            <Button variant="secondary" onClick={download}>
              {t('custom.csv')}
            </Button>
          </div>
        </section>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            { name: name.trim(), definition },
            {
              onSuccess: () => toast.show({ message: t('custom.saved') }),
              onError: () => toast.show({ message: t('custom.saveError'), tone: 'danger' }),
            },
          );
        }}
      >
        <Input
          label={t('custom.name')}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={!valid || !name.trim()}>
          {t('custom.save')}
        </Button>
      </form>
    </div>
  );
}
