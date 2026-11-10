import { AnnouncementBanner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { orgBillingQuery } from './api.ts';

/**
 * Across the admin pages for the owner of a business whose payment failed (past_due, with the date
 * paid features end) or whose subscription is unpaid. Hidden for everyone else and while billing is
 * off: the database answers `enabled`, and only owners may ask it (#1083).
 */
export function PastDueBanner() {
  const org = useCurrentOrg();
  if (!org || org.role !== 'owner') return null;
  return <Banner orgId={org.id} />;
}

function Banner({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('common');
  const billing = useQuery(orgBillingQuery(orgId)).data;
  if (!billing?.enabled || (billing.status !== 'past_due' && billing.status !== 'unpaid')) {
    return null;
  }
  const date =
    billing.status === 'past_due' && billing.graceEndsAt
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
          new Date(billing.graceEndsAt),
        )
      : null;
  return (
    <div data-testid="past-due-banner">
      <AnnouncementBanner
        severity="warning"
        label={t('pastDueBanner.label')}
        message={date ? t('pastDueBanner.pastDue', { date }) : t('pastDueBanner.unpaid')}
        dismissLabel=""
      />
      <p className="px-6 py-2">
        <Link to="/admin/billing" className="inline-flex min-h-target items-center underline">
          {t('pastDueBanner.link')}
        </Link>
      </p>
    </div>
  );
}
