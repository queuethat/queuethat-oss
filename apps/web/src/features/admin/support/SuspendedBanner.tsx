import { AnnouncementBanner } from '@qm/ui';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { supabase } from '../../../lib/supabase.ts';
import { useCurrentOrg } from '../../auth/current.ts';
import { useFormat } from './format.ts';

const POLL_MS = 30_000;

const orgStatusQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['org-status', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('app')
        .from('organizations')
        .select('status, suspended_reason, suspended_at')
        .eq('id', orgId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    refetchInterval: POLL_MS,
  });

/**
 * On every staff and admin page of a suspended business: why, since when, and what that means
 * (the database refuses queue changes; guests can't join). Can't be dismissed; support lifts it.
 */
export function SuspendedBanner() {
  const org = useCurrentOrg();
  if (!org) return null;
  return <SuspendedBannerFor orgId={org.id} />;
}

function SuspendedBannerFor({ orgId }: { orgId: string }) {
  const { t } = useTranslation('common');
  const format = useFormat();
  const row = useQuery(orgStatusQuery(orgId)).data;
  if (row?.status !== 'suspended') return null;
  return (
    <div data-testid="suspended-banner">
      <AnnouncementBanner
        severity="warning"
        label={t('suspendedBanner.label')}
        message={t(row.suspended_at ? 'suspendedBanner.message' : 'suspendedBanner.noDate', {
          at: row.suspended_at ? format(row.suspended_at) : '',
          reason: row.suspended_reason ?? t('suspendedBanner.noReason'),
        })}
        dismissLabel=""
      />
    </div>
  );
}
