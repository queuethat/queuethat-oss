import { AnnouncementBanner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import { unacknowledgedNoticesQuery } from './api.ts';

/**
 * Across the admin pages for admins and owners of a business that received a platform security
 * notice it has not confirmed reading (C9, #1275). It goes away when the notice is acknowledged
 * on the privacy page.
 */
export function IncidentBanner() {
  const org = useCurrentOrg();
  if (!org || (org.role !== 'owner' && org.role !== 'admin')) return null;
  return <Banner orgId={org.id} />;
}

function Banner({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-privacy');
  const pending = useQuery(unacknowledgedNoticesQuery(orgId)).data;
  if (!pending?.length) return null;
  return (
    <div data-testid="incident-banner">
      <AnnouncementBanner
        severity="warning"
        label={t('privacy.incidents.bannerLabel')}
        message={t('privacy.incidents.banner', { count: pending.length })}
        dismissLabel=""
      />
      <p className="px-6 py-2">
        <Link
          to="/admin/privacy"
          hash="incidents"
          className="inline-flex min-h-target items-center underline"
        >
          {t('privacy.incidents.bannerLink')}
        </Link>
      </p>
    </div>
  );
}
