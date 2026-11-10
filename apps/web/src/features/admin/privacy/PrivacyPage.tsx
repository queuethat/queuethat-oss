import { PageHeader, Skeleton, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { BACKUP_DAYS, retentionRunsQuery } from './api.ts';
import { Contacts } from './contacts/Contacts.tsx';
import { IncidentLog } from './incidents/IncidentLog.tsx';
import { Retention } from './retention/Retention.tsx';

/** How long guest details are kept, what the clean-up did, and the backup caveat (2P-PRV2, #189). */
export function PrivacyPage() {
  const { t } = useTranslation('admin-privacy');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  const canEdit = org.role === 'owner' || org.role === 'admin';
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('privacy.title')} />
      <Retention orgId={org.id} canEdit={canEdit} />
      <Contacts orgId={org.id} canEdit={canEdit} />
      {canEdit ? (
        <IncidentLog orgId={org.id} canEdit={canEdit} isOwner={org.role === 'owner'} />
      ) : null}
      <p className="text-muted">{t('privacy.backups', { count: BACKUP_DAYS })}</p>
      {canEdit ? <Runs orgId={org.id} /> : null}
    </div>
  );
}

function Runs({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('admin-privacy');
  const runs = useQuery(retentionRunsQuery(orgId));
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section aria-labelledby="runs-h" className="flex flex-col gap-3">
      <h2 id="runs-h" className="text-xl font-semibold">
        {t('privacy.runs.title')}
      </h2>
      {runs.isPending ? (
        <Spinner label={t('loading')} />
      ) : runs.data?.length ? (
        <ul className="flex flex-col gap-2">
          {runs.data.map((r) => (
            <li key={r.id} data-testid="retention-run">
              {t('privacy.runs.row', {
                at: when.format(new Date(r.ranAt)),
                visits: r.visitsAnonymized,
                contacts: r.contactsDeleted,
                appointments: r.appointmentsAnonymized,
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t('privacy.runs.none')}</p>
      )}
    </section>
  );
}
