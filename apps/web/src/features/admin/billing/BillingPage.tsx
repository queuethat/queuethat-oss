import { Badge, Button, Card, PageHeader, ScrollRegion, Segmented, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import {
  creditQuery,
  orgBillingQuery,
  TOPUP_AMOUNTS,
  useOpenBilling,
  type BillingPlan,
  type Interval,
  type OrgBilling,
} from './api.ts';

const COLS = ['date', 'type', 'cost', 'margin', 'amount'] as const;

function formatDate(iso: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/** A plan's price per location for the interval; a plan without an annual price is free or monthly only. */
function planMoney(plan: BillingPlan, language: string, interval: Interval) {
  const minor =
    interval === 'year' ? (plan.unitPriceAnnualMinor ?? plan.unitPriceMinor) : plan.unitPriceMinor;
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: plan.currency.toUpperCase(),
  }).format(minor / 100);
}

/** The plan a free org can move to: the cheapest one that costs something. */
function paidPlan(billing: OrgBilling) {
  return billing.plans.find((p) => p.unitPriceMinor > 0);
}

/** The percent off the annual price against twelve months: display arithmetic on two database prices. */
function savingPercent(billing: OrgBilling) {
  const p = paidPlan(billing);
  if (!p?.unitPriceAnnualMinor) return 0;
  return Math.round((1 - p.unitPriceAnnualMinor / (p.unitPriceMinor * 12)) * 100);
}

/** Free beside the paid plan: price, limits and paid channels as the database defines them. */
function PlanComparison({
  billing,
  interval,
  onInterval,
}: {
  billing: OrgBilling;
  interval: Interval;
  /** Set when the paid plan has an annual price; the toggle is shown only then. */
  onInterval?: (interval: Interval) => void;
}) {
  const { t, i18n } = useTranslation('admin-billing');
  const limit = (n: number) => (n < 0 ? t('compare.unlimited') : String(n));
  const rows: Array<[string, (p: BillingPlan) => string]> = [
    [
      t('compare.price'),
      (p) => t(`pricePerLocation.${interval}`, { amount: planMoney(p, i18n.language, interval) }),
    ],
    [t('compare.locations'), (p) => limit(p.maxLocations)],
    [t('compare.seats'), (p) => limit(p.maxMembers)],
    [t('compare.messages'), (p) => t(p.paidChannels ? 'compare.included' : 'compare.notIncluded')],
  ];
  return (
    <Card className="flex flex-col gap-4">
      {onInterval && (
        <Segmented
          label={t('interval.label')}
          hint={
            interval === 'year' && savingPercent(billing) > 0
              ? t('interval.save', { percent: savingPercent(billing) })
              : undefined
          }
          options={[
            { value: 'month', label: t('interval.month') },
            { value: 'year', label: t('interval.year') },
          ]}
          value={interval}
          onChange={(v) => onInterval(v as Interval)}
        />
      )}
      <ScrollRegion label={t('compare.caption')}>
        <table className="w-full text-left">
          <caption className="sr-only">{t('compare.caption')}</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2">
                <span className="sr-only">{t('compare.feature')}</span>
              </th>
              {billing.plans.map((p) => (
                <th key={p.id} scope="col" className="p-2 align-top">
                  {p.name}
                  {p.id === billing.planId && (
                    <>
                      {' '}
                      <Badge tone="info">{t('compare.current')}</Badge>
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-t border-border">
                <th scope="row" className="p-2 font-medium text-muted">
                  {label}
                </th>
                {billing.plans.map((p) => (
                  <td key={p.id} className="p-2">
                    {value(p)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </Card>
  );
}

function Summary({
  orgId,
  billing,
  interval,
}: {
  orgId: string;
  billing: OrgBilling;
  /** What a new subscription would be billed at (the toggle). */
  interval: Interval;
}) {
  const { t, i18n } = useTranslation('admin-billing');
  const open = useOpenBilling(orgId);
  const money = (minor: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: billing.currency }).format(
      minor / 100,
    );
  const date = billing.graceEndsAt ? formatDate(billing.graceEndsAt, i18n.language) : '';
  const banner =
    billing.status === 'past_due'
      ? t('banner.pastDue', { date })
      : billing.status === 'unpaid'
        ? t('banner.unpaid')
        : billing.status === 'canceled'
          ? t('banner.canceled')
          : billing.status === 'incomplete'
            ? t('banner.incomplete')
            : null;
  // A live subscription is shown at how it is billed; the toggle only prices a new one.
  const held = billing.subscribed ? billing.billingInterval : 'month';
  const current = billing.plans.find((p) => p.id === billing.planId);
  const unit =
    held === 'year'
      ? (current?.unitPriceAnnualMinor ?? billing.unitPriceMinor)
      : billing.unitPriceMinor;
  const target = paidPlan(billing);
  const subscribeLabel = target
    ? t('subscribePrice', {
        price: t(`pricePerLocation.${interval}`, {
          amount: planMoney(target, i18n.language, interval),
        }),
      })
    : t('subscribe');
  return (
    <Card className="flex flex-col gap-4">
      {banner && (
        <p role="status" className="font-medium text-warning-strong" data-testid="billing-banner">
          {banner}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-muted">{t('plan')}</dt>
        <dd className="font-medium">{billing.planName}</dd>
        <dt className="text-muted">{t('perLocation')}</dt>
        <dd>{t(`price.${held}`, { amount: money(unit) })}</dd>
        <dt className="text-muted">{t('locations')}</dt>
        <dd>{billing.locations}</dd>
        <dt className="text-muted">{t('total')}</dt>
        <dd>{t(`price.${held}`, { amount: money(unit * billing.locations) })}</dd>
        {billing.currentPeriodEnd && (
          <>
            <dt className="text-muted">{t('nextInvoice')}</dt>
            <dd>{formatDate(billing.currentPeriodEnd, i18n.language)}</dd>
          </>
        )}
      </dl>
      <Button
        disabled={open.isPending}
        onClick={() => open.mutate(billing.subscribed ? 'portal' : { checkout: interval })}
      >
        {billing.subscribed ? t('manage') : subscribeLabel}
      </Button>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {open.isError ? t('openError') : null}
      </p>
    </Card>
  );
}

function Credit({ orgId, currency }: { orgId: string; currency: string }) {
  const { t, i18n } = useTranslation('admin-billing');
  const credit = useQuery(creditQuery(orgId));
  const open = useOpenBilling(orgId);
  const money = (micros: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(micros / 1e6);
  if (!credit.data) return null;
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">{t('credit.title')}</h2>
      <p>{t('credit.balance', { amount: money(credit.data.balanceMicros) })}</p>
      <p className="text-muted">{t('credit.note')}</p>
      <div className="flex flex-wrap gap-2">
        {TOPUP_AMOUNTS.map((minor) => (
          <Button
            key={minor}
            variant="secondary"
            disabled={open.isPending}
            onClick={() => open.mutate({ topup: minor })}
          >
            {t('credit.add', { amount: money(minor * 10000) })}
          </Button>
        ))}
      </div>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {open.isError ? t('openError') : null}
      </p>
      {credit.data.entries.length > 0 && (
        <ScrollRegion label={t('credit.history')}>
          <table className="w-full text-left">
            <caption className="sr-only">{t('credit.history')}</caption>
            <thead>
              <tr>
                {COLS.map((k) => (
                  <th key={k} scope="col" className="p-2">
                    {t(`credit.col.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {credit.data.entries.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="p-2">{formatDate(e.createdAt, i18n.language)}</td>
                  <td className="p-2">{t(`credit.type.${e.type}`)}</td>
                  <td className="p-2">
                    {e.type === 'topup' || e.type === 'addon_allowance' ? '' : money(e.costMicros)}
                  </td>
                  <td className="p-2">
                    {e.type === 'topup' || e.type === 'addon_allowance'
                      ? ''
                      : money(e.marginMicros)}
                  </td>
                  <td className="p-2">{money(e.amountMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Card>
  );
}

/**
 * `/admin/billing` (4-BILL2, #378): the owner's plan, price per location and next invoice, with
 * Stripe's Customer Portal for cards, invoices and cancellation. Hidden while billing is off.
 */
export function BillingPage() {
  const { t } = useTranslation('admin-billing');
  const [interval, setInterval] = useState<Interval>('month');
  const org = useCurrentOrg();
  const isOwner = org?.role === 'owner';
  const billing = useQuery({ ...orgBillingQuery(org?.id ?? ''), enabled: !!org && isOwner });
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  if (!isOwner) return <p className="mx-auto max-w-4xl">{t('ownersOnly')}</p>;
  if (billing.isError)
    return (
      <p role="alert" className="mx-auto max-w-2xl">
        {t('error')}
      </p>
    );
  if (!billing.data) return <Skeleton label={t('loading')} rows={2} />;
  // Billing off: the page does not exist for this deployment.
  if (!billing.data.enabled) return <p className="mx-auto max-w-4xl">{t('notAvailable')}</p>;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      <Summary orgId={org.id} billing={billing.data} interval={interval} />
      {!billing.data.subscribed && billing.data.plans.length > 1 && (
        <PlanComparison
          billing={billing.data}
          interval={interval}
          onInterval={
            paidPlan(billing.data)?.unitPriceAnnualMinor != null ? setInterval : undefined
          }
        />
      )}
      {billing.data.paidChannels && <Credit orgId={org.id} currency={billing.data.currency} />}
    </div>
  );
}
