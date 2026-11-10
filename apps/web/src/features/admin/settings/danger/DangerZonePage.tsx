import { Button, ConfirmDestructive, Input, PageHeader, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';
import { orgDeletionQuery, useCancelOrgDeletion, useRequestOrgDeletion } from './api.ts';

const KNOWN_ERRORS = ['invalid_input', 'permission_denied', 'not_found', 'mfa_required'];

/** The owner's last resort: schedule the business for deletion, or call it off (2P-PRV9, #196). */
export function DangerZonePage() {
  const { t } = useTranslation('admin-privacy');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-8">
      <PageHeader title={t('danger.title')} />
      {org.role === 'owner' ? (
        <div className="rounded-card border border-danger p-4 sm:p-6">
          <OwnerZone orgId={org.id} />
        </div>
      ) : (
        <p>{t('danger.ownersOnly')}</p>
      )}
    </div>
  );
}

function OwnerZone({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('admin-privacy');
  const due = useQuery(orgDeletionQuery(orgId));
  const { locations } = useCurrentLocation();
  const request = useRequestOrgDeletion(orgId);
  const cancel = useCancelOrgDeletion(orgId);
  const [typed, setTyped] = useState('');
  // The database compares with the business's first location, the oldest one.
  const slug = locations
    .filter((l) => l.org_id === orgId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.slug;
  if (due.isPending) return <Skeleton label={t('loading')} rows={2} />;

  if (due.data) {
    const when = new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(new Date(due.data));
    return (
      <section className="flex flex-col gap-4" aria-labelledby="pending-h">
        <h2 id="pending-h" className="text-xl font-semibold">
          {t('danger.pending.title')}
        </h2>
        <p data-testid="purge-date">{t('danger.pending.body', { when })}</p>
        <Button className="self-start" loading={cancel.isPending} onClick={() => cancel.mutate()}>
          {t('danger.pending.cancel')}
        </Button>
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {cancel.isError ? t('danger.errors.unknown') : null}
        </p>
      </section>
    );
  }

  const failure = request.error
    ? (`danger.errors.${KNOWN_ERRORS.includes(request.error.message) ? request.error.message : 'unknown'}` as 'danger.errors.unknown')
    : null;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="delete-h">
      <h2 id="delete-h" className="text-xl font-semibold">
        {t('danger.delete.title')}
      </h2>
      <p>{t('danger.delete.effects')}</p>
      <ul className="list-disc ps-6">
        <li>{t('danger.delete.effectLocked')}</li>
        <li>{t('danger.delete.effectGuests')}</li>
        <li>{t('danger.delete.effectPurge')}</li>
      </ul>
      <p>{t('danger.delete.export')}</p>
      <ConfirmDestructive
        triggerLabel={t('danger.delete.trigger')}
        title={t('danger.delete.confirmTitle')}
        description={t('danger.delete.confirmBody')}
        confirmLabel={t('danger.delete.confirm')}
        cancelLabel={t('danger.delete.cancel')}
        confirmDisabled={!slug || typed.trim() !== slug}
        onConfirm={() => request.mutateAsync(typed.trim()).catch(() => undefined)}
      >
        <Input
          label={t('danger.delete.typeSlug', { slug })}
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {failure ? t(failure) : null}
        </p>
      </ConfirmDestructive>
    </section>
  );
}
