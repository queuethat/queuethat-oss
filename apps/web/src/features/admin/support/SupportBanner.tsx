import { AnnouncementBanner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { useNow } from '../../../lib/now.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { liveGrants, supportGrantsQuery } from './api.ts';
import { useFormat } from './format.ts';

/**
 * PLT14 (#420): on every staff and admin page while support can see this business: what they
 * can do and until when. Break-glass (an operator's emergency access) gets the stronger warning.
 * It can't be dismissed; the owner ends it on /admin/settings/support.
 */
export function SupportBanner() {
  const org = useCurrentOrg();
  if (!org) return null;
  return <SupportBannerFor orgId={org.id} />;
}

function SupportBannerFor({ orgId }: { orgId: string }) {
  const { t } = useTranslation('common');
  const format = useFormat();
  const now = useNow(15_000);
  const grants = useQuery(supportGrantsQuery(orgId)).data ?? [];
  const live = liveGrants(grants, now);
  if (live.length === 0) return null;
  return (
    <div data-testid="support-banner">
      {live.map((g) => (
        <AnnouncementBanner
          key={g.id}
          severity={g.break_glass ? 'maintenance' : 'warning'}
          label={t(g.break_glass ? 'supportBanner.breakGlass' : 'supportBanner.label')}
          message={t(`supportBanner.${g.scope}`, {
            until: format(g.expires_at),
            reason: g.reason,
          })}
          dismissLabel=""
        />
      ))}
    </div>
  );
}
