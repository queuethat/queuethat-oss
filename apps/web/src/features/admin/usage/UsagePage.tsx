import {
  BarChart,
  Button,
  Card,
  Checkbox,
  Input,
  PageHeader,
  ScrollRegion,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { isoDay } from '../analytics/csv.ts';
import {
  DEFAULT_DAILY_CAP,
  limitsQuery,
  PAID_CHANNELS,
  todayCountsQuery,
  useSaveLimits,
  usageSummaryQuery,
  type ChannelLimit,
  type PaidChannel,
} from './api.ts';
import { COUNTRIES, percentOf, WARN_PCT } from './countries.ts';

const COLS = ['day', 'channel', 'provider', 'messages', 'segments', 'cost'] as const;
const money = (micros: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 4 }).format(
    micros / 1e6,
  );

function Meters({ orgId, limits }: { orgId: string; limits: Record<string, ChannelLimit> }) {
  const { t } = useTranslation('admin-usage');
  const today = isoDay();
  const counts = useQuery(todayCountsQuery(orgId, today));
  return (
    <section aria-labelledby="usage-today" className="flex flex-col gap-3">
      <h2 id="usage-today" className="text-xl font-semibold">
        {t('today.title')}
      </h2>
      <p className="text-muted">{t('today.resets')}</p>
      {PAID_CHANNELS.map((channel) => {
        const sent = counts.data?.[channel] ?? 0;
        const cap = limits[channel]?.dailyCap ?? DEFAULT_DAILY_CAP;
        const pct = percentOf(sent, cap);
        return (
          <div key={channel} className="flex flex-col gap-1">
            {pct >= WARN_PCT && (
              <p
                role="status"
                className="font-medium text-warning-strong"
                data-testid={`banner-${channel}`}
              >
                {t(pct >= 100 ? 'today.full' : 'today.nearly', {
                  channel: t(`channel.${channel}`),
                  pct,
                })}
              </p>
            )}
            <label htmlFor={`meter-${channel}`}>
              {t('today.count', { channel: t(`channel.${channel}`), sent, cap })}
            </label>
            <progress
              id={`meter-${channel}`}
              value={Math.min(sent, cap)}
              max={Math.max(cap, 1)}
              className="h-3 w-full"
            />
          </div>
        );
      })}
    </section>
  );
}

function LimitsForm({
  orgId,
  limits,
  canEdit,
}: {
  orgId: string;
  limits: Record<string, ChannelLimit>;
  canEdit: boolean;
}) {
  const { t, i18n } = useTranslation('admin-usage');
  const save = useSaveLimits(orgId);
  const names = new Intl.DisplayNames(i18n.language, { type: 'region' });
  const first = limits.sms ?? limits.whatsapp;
  const [caps, setCaps] = useState<Record<PaidChannel, string>>({
    sms: String(limits.sms?.dailyCap ?? DEFAULT_DAILY_CAP),
    whatsapp: String(limits.whatsapp?.dailyCap ?? DEFAULT_DAILY_CAP),
  });
  const [budget, setBudget] = useState(
    first?.monthlyBudgetMicros != null ? String(first.monthlyBudgetMicros / 1e6) : '',
  );
  const [countries, setCountries] = useState<string[]>(first?.countryAllowlist ?? []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      caps: { sms: Number(caps.sms), whatsapp: Number(caps.whatsapp) },
      budgetMicros: budget.trim() === '' ? null : Math.round(Number(budget) * 1e6),
      countries,
    });
  };
  return (
    <Card className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="usage-limits">
        <h2 id="usage-limits" className="text-xl font-semibold">
          {t('limits.title')}
        </h2>
        {canEdit ? null : <p className="text-muted">{t('limits.readOnly')}</p>}
        <div className="grid gap-4 sm:grid-cols-3">
          {PAID_CHANNELS.map((c) => (
            <Input
              key={c}
              label={t('limits.cap', { channel: t(`channel.${c}`) })}
              type="number"
              min={0}
              max={100000}
              value={caps[c]}
              disabled={!canEdit}
              onChange={(e) => setCaps({ ...caps, [c]: e.target.value })}
            />
          ))}
          <Input
            label={t('limits.budget')}
            hint={t('limits.budgetHint')}
            type="number"
            min={0}
            step="0.01"
            value={budget}
            disabled={!canEdit}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('limits.countries')}</legend>
          <p className="text-muted">
            {countries.length === 0 ? t('limits.noneAllowed') : t('limits.sharedCode')}
          </p>
          <ScrollRegion label={t('limits.countries')}>
            <div className="grid gap-1 sm:grid-cols-2">
              {COUNTRIES.map((code) => (
                <Checkbox
                  key={code}
                  label={names.of(code) ?? code}
                  checked={countries.includes(code)}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setCountries(
                      e.target.checked ? [...countries, code] : countries.filter((c) => c !== code),
                    )
                  }
                />
              ))}
            </div>
          </ScrollRegion>
        </fieldset>
        {canEdit && (
          <Button type="submit" disabled={save.isPending}>
            {t('limits.save')}
          </Button>
        )}
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {save.isError ? t('limits.error') : null}
        </p>
        <p role="status" className="empty:hidden">
          {save.isSuccess ? t('limits.saved') : null}
        </p>
      </form>
    </Card>
  );
}

/**
 * `/admin/usage` (3-PV5, #344): what paid messages cost per day, today's sends against the daily
 * caps, and the limits `api.reserve_send` enforces. Managers read; admins and owners edit.
 */
export function UsagePage() {
  const { t, i18n } = useTranslation('admin-usage');
  const org = useCurrentOrg();
  const from = isoDay(29);
  const to = isoDay();
  const summary = useQuery({ ...usageSummaryQuery(org?.id ?? '', from, to), enabled: !!org });
  const limits = useQuery({ ...limitsQuery(org?.id ?? ''), enabled: !!org });
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  const role = org.role;
  const manager = role === 'manager' || role === 'admin' || role === 'owner';
  if (!manager) return <p className="mx-auto max-w-4xl">{t('managersOnly')}</p>;
  if (summary.isError || limits.isError)
    return (
      <p role="alert" className="mx-auto max-w-4xl">
        {t('error')}
      </p>
    );
  if (!summary.data || !limits.data) return <Skeleton label={t('loading')} rows={2} />;

  const perDay = new Map<string, number>();
  for (const r of summary.data) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.messages);
  const bars = [...perDay].map(([day, value]) => ({ key: day, label: `${day}: ${value}`, value }));

  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      <Meters orgId={org.id} limits={limits.data} />
      <LimitsForm
        key={org.id}
        orgId={org.id}
        limits={limits.data}
        canEdit={role === 'admin' || role === 'owner'}
      />
      <section aria-labelledby="usage-spend" className="flex flex-col gap-3">
        <h2 id="usage-spend" className="text-xl font-semibold">
          {t('spend.title')}
        </h2>
        {summary.data.length === 0 ? (
          <p>{t('spend.empty')}</p>
        ) : (
          <>
            <BarChart label={t('spend.chart')} bars={bars} />
            <ScrollRegion label={t('spend.title')}>
              <table className="w-full text-left">
                <caption className="sr-only">{t('spend.title')}</caption>
                <thead>
                  <tr>
                    {COLS.map((k) => (
                      <th key={k} scope="col" className="p-2">
                        {t(`spend.col.${k}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.data.map((r) => (
                    <tr key={`${r.day}-${r.kind}-${r.provider}`} className="border-t border-border">
                      <th scope="row" className="p-2 font-normal">
                        {r.day}
                      </th>
                      <td className="p-2">{t(`channel.${r.kind}`, { defaultValue: r.kind })}</td>
                      <td className="p-2">{r.provider}</td>
                      <td className="p-2">{r.messages}</td>
                      <td className="p-2">{r.segments}</td>
                      <td className="p-2">{money(r.costMicros, r.currency, i18n.language)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </>
        )}
      </section>
    </div>
  );
}
