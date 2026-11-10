import { Badge, Card, EmptyState, Spinner, type Tone } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { appConfig } from '../../../lib/config.ts';
import { formatWhen } from '../format.ts';
import { orgBillingQuery, type BillingStanding } from './api.ts';
import { stripeCustomerUrl } from './stripe.ts';

const STANDING_TONE: Record<BillingStanding, Tone> = {
  billing_off: 'neutral',
  no_subscription: 'neutral',
  good: 'success',
  grace: 'warning',
  free: 'danger',
};

/** A status Stripe reports, as a tone: only a paying status is calm. */
function statusTone(status: string): Tone {
  if (status === 'active' || status === 'trialing') return 'success';
  if (status === 'past_due' || status === 'paused') return 'warning';
  return 'danger';
}

const KNOWN_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
] as const;

/**
 * The Billing section of the platform org page (#1131): why the tenant is on the plan it is on,
 * what it is billed for, its resolved limits and the overrides operators set. Everything shown is
 * what `api.platform_org_billing` returns; limits are never recomputed here, and the only Stripe
 * identifier is the customer id behind the "Open in Stripe" link.
 */
export function BillingPanel({
  orgId,
  dashboardUrl = appConfig().stripeDashboardUrl,
}: {
  orgId: string;
  dashboardUrl?: string;
}) {
  const { t, i18n } = useTranslation('platform');
  const billing = useQuery(orgBillingQuery(orgId));
  const when = (at: string | null, fallback = '') => formatWhen(at, i18n.language, fallback);
  const none = t('billing.none');

  if (billing.isError) {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{t('billing.title')}</h2>
        <EmptyState title={t('billing.loadFailed')} />
      </Card>
    );
  }
  if (!billing.data) return <Spinner label={t('billing.loading')} />;
  const b = billing.data;
  const stripeUrl = stripeCustomerUrl(b.stripe_customer_id, dashboardUrl);
  const statusLabel = (status: string) => {
    const known = KNOWN_STATUSES.find((s) => s === status);
    return known ? t(`billing.statuses.${known}`) : status;
  };
  const quantityDiffers =
    b.has_subscription &&
    b.locations_billed !== null &&
    (b.locations_billed !== b.locations_actual || b.locations_wanted !== b.locations_actual);

  return (
    <Card className="flex flex-col gap-4" aria-labelledby="billing-title">
      <h2 id="billing-title" className="flex flex-wrap items-center gap-3 text-xl font-semibold">
        {t('billing.title')}
        <Badge tone={STANDING_TONE[b.standing]}>{t(`billing.standing.${b.standing}`)}</Badge>
        {b.status ? <Badge tone={statusTone(b.status)}>{statusLabel(b.status)}</Badge> : null}
      </h2>

      <p role="status" data-testid="billing-why">
        {t(`billing.why.${b.standing}`, {
          plan: b.plan_name ?? b.plan_id ?? '',
          until: when(b.grace_ends_at),
        })}
        {b.org_status === 'active' ? '' : ` ${t(`billing.orgStatus.${b.org_status}`)}`}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-muted">{t('billing.plan')}</dt>
        <dd>
          {b.plan_name
            ? `${b.plan_name}${
                b.billing_interval ? ` · ${t(`billing.interval.${b.billing_interval}`)}` : ''
              }`
            : none}
        </dd>
        <dt className="text-muted">{t('billing.effectivePlan')}</dt>
        <dd>{b.effective_plan ?? t('billing.noPlanApplies')}</dd>
        <dt className="text-muted">{t('billing.periodEnd')}</dt>
        <dd>{when(b.current_period_end, none)}</dd>
        <dt className="text-muted">{t('billing.locations')}</dt>
        <dd>
          {b.has_subscription
            ? t('billing.locationCounts', {
                billed: b.locations_billed ?? 0,
                wanted: b.locations_wanted ?? 0,
                actual: b.locations_actual,
              })
            : t('billing.locationsActual', { actual: b.locations_actual })}
          {quantityDiffers ? (
            <span className="block text-muted" data-testid="billing-quantity-mismatch">
              {t('billing.quantityDiffers')}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted">{t('billing.graceEnds')}</dt>
        <dd>{when(b.grace_ends_at, none)}</dd>
        <dt className="text-muted">{t('billing.lastFailed')}</dt>
        <dd>{when(b.last_payment_failed_at, none)}</dd>
        <dt className="text-muted">{t('billing.reminder')}</dt>
        <dd>{when(b.grace_reminder_at, none)}</dd>
        <dt className="text-muted">{t('billing.stripe')}</dt>
        <dd className="break-all">
          {stripeUrl ? (
            <a href={stripeUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {t('billing.openInStripe')}
            </a>
          ) : (
            t('billing.noCustomer')
          )}
        </dd>
      </dl>

      <section aria-labelledby="billing-limits" className="flex flex-col gap-2">
        <h3 id="billing-limits" className="text-lg font-semibold">
          {t('billing.limits')}
        </h3>
        <table className="w-full text-left">
          <thead className="text-sm text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4">
                {t('billing.key')}
              </th>
              <th scope="col" className="py-2 pr-4">
                {t('billing.value')}
              </th>
              <th scope="col" className="py-2">
                {t('billing.source')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {b.entitlements.map((e) => (
              <tr key={e.key}>
                <th scope="row" className="py-2 pr-4 font-mono font-normal">
                  {e.key}
                </th>
                <td className="py-2 pr-4 font-mono">{JSON.stringify(e.value)}</td>
                <td className="py-2">{t(`billing.sources.${e.source}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="billing-overrides" className="flex flex-col gap-2">
        <h3 id="billing-overrides" className="text-lg font-semibold">
          {t('billing.overrides')}
        </h3>
        {b.overrides.length === 0 ? (
          <p>{t('billing.noOverrides')}</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.key')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.value')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.reason')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.setBy')}
                </th>
                <th scope="col" className="py-2">
                  {t('billing.setAt')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {b.overrides.map((o) => (
                <tr key={o.key}>
                  <th scope="row" className="py-2 pr-4 font-mono font-normal">
                    {o.key}
                  </th>
                  <td className="py-2 pr-4 font-mono">{JSON.stringify(o.value)}</td>
                  <td className="py-2 pr-4">{o.reason}</td>
                  <td className="py-2 pr-4 break-all">
                    {o.set_by_email ?? t('billing.unknownUser')}
                  </td>
                  <td className="py-2">{when(o.set_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="billing-jobs" className="flex flex-col gap-2">
        <h3 id="billing-jobs" className="text-lg font-semibold">
          {t('billing.jobs')}
        </h3>
        {b.pending_jobs.length === 0 ? (
          <p>{t('billing.noJobs')}</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.jobStatus')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.attempts')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('billing.nextAttempt')}
                </th>
                <th scope="col" className="py-2">
                  {t('billing.lastError')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {b.pending_jobs.map((j, i) => (
                <tr key={`${j.created_at}-${i}`}>
                  <td className="py-2 pr-4">{t(`billing.jobStatuses.${j.status}`)}</td>
                  <td className="py-2 pr-4">{j.attempts}</td>
                  <td className="py-2 pr-4">{when(j.next_attempt_at)}</td>
                  <td className="py-2 font-mono">{j.last_error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Card>
  );
}
