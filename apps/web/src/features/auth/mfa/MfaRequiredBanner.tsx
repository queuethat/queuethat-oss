import { AnnouncementBanner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { requireMfaQuery } from '../../admin/settings/api.ts';
import { useCurrentOrg } from '../current.ts';
import { mfaStatusQuery } from './api.ts';

/**
 * On staff and admin pages: this business requires 2FA for owners and admins and the signed-in
 * owner or admin has no authenticator app yet, so their admin rights are paused until they add one.
 */
export function MfaRequiredBanner() {
  const org = useCurrentOrg();
  if (!org || (org.role !== 'owner' && org.role !== 'admin')) return null;
  return <Banner orgId={org.id} />;
}

function Banner({ orgId }: { orgId: string }) {
  const { t } = useTranslation('common');
  const required = useQuery(requireMfaQuery(orgId)).data;
  const status = useQuery(mfaStatusQuery).data;
  if (!required || !status || status.factors.length > 0) return null;
  return (
    <div data-testid="mfa-required-banner">
      <AnnouncementBanner
        severity="warning"
        label={t('mfaBanner.label')}
        message={t('mfaBanner.message')}
        dismissLabel=""
      />
      <p className="px-6 py-2">
        <Link to="/admin/account/security" className="underline">
          {t('mfaBanner.link')}
        </Link>
      </p>
    </div>
  );
}
