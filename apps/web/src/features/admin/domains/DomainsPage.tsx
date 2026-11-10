import {
  Badge,
  Button,
  ConfirmDestructive,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import {
  canManageDomains,
  domainsQuery,
  mainHostname,
  useAddDomain,
  useRemoveDomain,
  useVerifyDomain,
} from './api.ts';

const TONES = {
  verified: 'success',
  pending: 'neutral',
  failed: 'warning',
  disabled: 'danger',
} as const;
const ERRORS = ['invalid_input', 'domain_taken', 'permission_denied', 'not_found'];

/** `/admin/domains` (3-DOM2, #371): claim a hostname, copy the DNS records, check them, see the status. */
export function DomainsPage() {
  const { t } = useTranslation('admin-domains');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      {canManageDomains(org.role) ? (
        <DomainList orgId={org.id} />
      ) : (
        <p className="text-muted">{t('adminsOnly')}</p>
      )}
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation('admin-domains');
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1">
        <Input
          label={label}
          readOnly
          value={value}
          className="font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <Button
        variant="secondary"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? t('copied') : t('copy')}
      </Button>
    </div>
  );
}

function DomainList({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('admin-domains');
  const query = useQuery(domainsQuery(orgId));
  const remove = useRemoveDomain(orgId);
  const verify = useVerifyDomain(orgId);
  const [adding, setAdding] = useState(false);
  const { locations } = useCurrentLocation();

  if (query.isError) return <p role="alert">{t('errors.unknown')}</p>;
  if (!query.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="domains-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="domains-heading" className="text-xl font-semibold">
          {t('list.title')}
        </h2>
        <Button onClick={() => setAdding(true)}>{t('add.open')}</Button>
      </div>
      <p className="text-muted">{t('list.intro')}</p>
      {query.data.length === 0 ? (
        <EmptyState title={t('list.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((d) => (
            <li key={d.id} className="flex flex-col gap-3 py-4" data-testid="domain">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-semibold break-all">
                    {d.hostname}{' '}
                    <Badge tone={TONES[d.status as keyof typeof TONES] ?? 'neutral'}>
                      {t(`status.${d.status}` as 'status.pending')}
                    </Badge>
                  </p>
                  <p className="text-muted">
                    {locations.find((l) => l.id === d.default_location_id)?.name ?? ''}
                    {' · '}
                    {d.last_checked_at
                      ? t('list.lastChecked', {
                          date: new Date(d.last_checked_at).toLocaleString(i18n.language),
                        })
                      : t('list.neverChecked')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    loading={verify.isPending && verify.variables === d.id}
                    loadingLabel={t('verify.checking')}
                    onClick={() => verify.mutate(d.id)}
                  >
                    {t('verify.button')}
                  </Button>
                  <ConfirmDestructive
                    triggerLabel={t('remove.trigger')}
                    triggerAriaLabel={t('remove.triggerFor', { host: d.hostname })}
                    title={t('remove.title', { host: d.hostname })}
                    description={t('remove.description')}
                    confirmLabel={t('remove.confirm')}
                    cancelLabel={t('remove.cancel')}
                    triggerVariant="secondary"
                    onConfirm={() => remove.mutateAsync(d.id)}
                  />
                </div>
              </div>
              {verify.isError && verify.variables === d.id ? (
                <p role="alert">
                  {t(
                    verify.error.message === 'unavailable'
                      ? 'verify.unavailable'
                      : 'errors.unknown',
                  )}
                </p>
              ) : null}
              {d.status === 'verified' ? null : (
                <div className="flex flex-col gap-3">
                  <p className="text-muted">{t('records.intro')}</p>
                  <CopyValue label={t('records.txtName')} value={`_queue-verify.${d.hostname}`} />
                  <CopyValue label={t('records.txtValue')} value={d.verification_token} />
                </div>
              )}
              <CopyValue label={t('records.cname', { host: d.hostname })} value={mainHostname()} />
            </li>
          ))}
        </ul>
      )}
      <AddDomainDialog orgId={orgId} open={adding} onClose={() => setAdding(false)} />
    </section>
  );
}

function AddDomainDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin-domains');
  const add = useAddDomain(orgId);
  const { locations, location } = useCurrentLocation();
  const orgLocations = locations.filter((l) => l.org_id === orgId);
  const [hostname, setHostname] = useState('');
  const [picked, setPicked] = useState('');
  const locationId = picked || location?.id || '';

  const close = () => {
    add.reset();
    setHostname('');
    setPicked('');
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate({ hostname, locationId }, { onSuccess: close });
  };
  const failure = add.error
    ? ERRORS.includes(add.error.message)
      ? add.error.message
      : 'unknown'
    : null;
  return (
    <Dialog open={open} onClose={close} title={t('add.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('add.hostname')}
          hint={t('add.hostnameHint')}
          required
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
        />
        <Select
          label={t('add.location')}
          value={locationId}
          onChange={(e) => setPicked(e.target.value)}
        >
          {orgLocations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        {failure ? <p role="alert">{t(`errors.${failure}` as 'errors.unknown')}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={close}>
            {t('add.cancel')}
          </Button>
          <Button type="submit" loading={add.isPending} loadingLabel={t('add.adding')}>
            {t('add.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
