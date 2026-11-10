import { Button } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useSession, membershipsQuery } from '../../../auth/api.ts';
import { orgDeletionQuery, useCancelOrgDeletion } from './api.ts';

/**
 * Across every admin page while the business is scheduled for deletion: when the data goes, and
 * a way back for the owner. Only owners can ask the database, so only they see it (2P-PRV9, #196).
 */
export function DeletionBanner() {
  const userId = useSession().data?.user.id ?? '';
  const memberships = useQuery({ ...membershipsQuery(userId), enabled: !!userId });
  const owned = (memberships.data ?? []).filter((m) => m.role === 'owner');
  return (
    <>
      {owned.map((m) => (
        <BannerFor key={m.org_id} orgId={m.org_id} />
      ))}
    </>
  );
}

function BannerFor({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('admin');
  const due = useQuery(orgDeletionQuery(orgId)).data;
  const cancel = useCancelOrgDeletion(orgId);
  if (!due) return null;
  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(due));
  return (
    <div
      role="status"
      data-testid="deletion-banner"
      className="flex flex-wrap items-center gap-3 bg-danger-soft px-6 py-2 text-danger-strong"
    >
      <p className="flex-1">
        <strong className="font-semibold">{t('deletionBanner.label')}: </strong>
        {t('deletionBanner.message', { when })}
      </p>
      <Button variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>
        {t('deletionBanner.cancel')}
      </Button>
      <span role="alert" className="font-medium empty:hidden">
        {cancel.isError ? t('deletionBanner.failed') : null}
      </span>
    </div>
  );
}
