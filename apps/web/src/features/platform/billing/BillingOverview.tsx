import { Card } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen } from '../format.ts';
import { billingOverviewQuery } from './api.ts';

/**
 * Counts of past-due, canceled and trial-ending subscriptions with the orgs behind them, on the
 * tenant directory (#1131). Hidden while billing is off; a failed load says so instead of
 * showing zeros, because zero here means "nothing needs attention".
 */
export function BillingOverview() {
  const { t, i18n } = useTranslation('platform');
  const overview = useQuery(billingOverviewQuery);

  if (overview.isError) {
    return (
      <Card>
        <p role="alert">{t('billing.overviewFailed')}</p>
      </Card>
    );
  }
  if (!overview.data?.billing_enabled) return null;
  const o = overview.data;
  return (
    <Card className="flex flex-col gap-3" aria-labelledby="billing-overview">
      <h2 id="billing-overview" className="text-xl font-semibold">
        {t('billing.overview.title')}
      </h2>
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        <div>
          <dt className="text-muted">{t('billing.overview.pastDue')}</dt>
          <dd className="text-2xl font-semibold">{o.past_due}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('billing.overview.canceled')}</dt>
          <dd className="text-2xl font-semibold">{o.canceled_30d}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('billing.overview.trials')}</dt>
          <dd className="text-2xl font-semibold">{o.trials_ending_7d}</dd>
        </div>
      </dl>
      {o.attention.length === 0 ? (
        <p>{t('billing.overview.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {o.attention.map((a) => (
            <li key={`${a.org_id}-${a.reason}`} data-testid="billing-attention">
              <Link to="/platform/orgs/$orgId" params={{ orgId: a.org_id }} className="underline">
                {a.name}
              </Link>{' '}
              <span className="text-muted">
                {t(`billing.overview.reasons.${a.reason}`, {
                  at: formatWhen(a.at, i18n.language, ''),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
