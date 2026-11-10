import {
  Badge,
  Button,
  Checkbox,
  ConfirmDestructive,
  Dialog,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../../components/ScreenEmpty.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';
import {
  API_SCOPES,
  apiKeysQuery,
  canManageApiKeys,
  scopeKey,
  useCreateApiKey,
  useRevokeApiKey,
  type ApiScope,
} from './api.ts';

const DAY_MS = 86_400_000;
const EXPIRY_DAYS = ['never', '30', '90', '365'] as const;

/** API keys for integrations (I-5, #307): create with scopes, copy once, revoke. Admins and owners. */
export function ApiKeysPage() {
  const { t } = useTranslation('admin-api-keys');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      {canManageApiKeys(org.role) ? (
        <KeyList orgId={org.id} />
      ) : (
        <p className="text-muted">{t('adminsOnly')}</p>
      )}
    </div>
  );
}

function KeyList({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('admin-api-keys');
  const query = useQuery(apiKeysQuery(orgId));
  const revoke = useRevokeApiKey(orgId);
  const [creating, setCreating] = useState(false);
  const [now] = useState(() => Date.now());
  const { locations } = useCurrentLocation();
  const date = (value: string) => new Date(value).toLocaleDateString(i18n.language);

  if (query.isError) return <p role="alert">{t('errors.unknown')}</p>;
  if (!query.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="keys-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="keys-heading" className="text-xl font-semibold">
          {t('list.title')}
        </h2>
        <Button onClick={() => setCreating(true)}>{t('create.open')}</Button>
      </div>
      <p className="text-muted">{t('list.intro')}</p>
      {query.data.length === 0 ? (
        <ScreenEmpty kind="developers" />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((key) => {
            const revoked = !!key.revoked_at;
            const expired = !!key.expires_at && Date.parse(key.expires_at) <= now;
            const places = key.location_ids
              ? key.location_ids
                  .map((id) => locations.find((l) => l.id === id)?.name ?? id)
                  .join(', ')
              : t('list.allLocations');
            return (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid="api-key"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-semibold">
                    {key.name} {revoked ? <Badge tone="danger">{t('list.revoked')}</Badge> : null}
                    {!revoked && expired ? <Badge tone="warning">{t('list.expired')}</Badge> : null}
                  </p>
                  <p className="font-mono text-muted">{`qk_live_${key.prefix}_…`}</p>
                  <p className="text-muted">
                    {key.scopes
                      .map((scope) => t(`scope.${scopeKey(scope as ApiScope)}.name`))
                      .join(', ')}
                  </p>
                  <p className="text-muted">{places}</p>
                  <p className="text-muted">
                    {key.last_used_at
                      ? t('list.lastUsed', { date: date(key.last_used_at) })
                      : t('list.neverUsed')}
                    {' · '}
                    {key.expires_at
                      ? t('list.expires', { date: date(key.expires_at) })
                      : t('list.noExpiry')}
                  </p>
                </div>
                {revoked ? null : (
                  <ConfirmDestructive
                    triggerLabel={t('revoke.trigger')}
                    triggerAriaLabel={t('revoke.triggerFor', { name: key.name })}
                    title={t('revoke.title', { name: key.name })}
                    description={t('revoke.description')}
                    confirmLabel={t('revoke.confirm')}
                    cancelLabel={t('revoke.cancel')}
                    triggerVariant="secondary"
                    onConfirm={() => revoke.mutateAsync(key.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <CreateKeyDialog orgId={orgId} open={creating} onClose={() => setCreating(false)} />
    </section>
  );
}

/** The form, then the show-once panel. The plaintext lives only in this component's mutation. */
function CreateKeyDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin-api-keys');
  const create = useCreateApiKey(orgId);
  const { locations } = useCurrentLocation();
  const orgLocations = locations.filter((l) => l.org_id === orgId);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['queues:read']);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [expiry, setExpiry] = useState<(typeof EXPIRY_DAYS)[number]>('never');

  const close = () => {
    create.reset();
    setName('');
    setScopes(['queues:read']);
    setPicked(null);
    setExpiry('never');
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      name,
      scopes: API_SCOPES.filter((s) => scopes.includes(s)),
      locationIds: picked && picked.length > 0 ? picked : null,
      expiresAt:
        expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * DAY_MS).toISOString(),
    });
  };

  if (create.data) {
    return (
      <Dialog
        open={open}
        onClose={() => undefined}
        title={t('shown.title')}
        description={t('shown.description')}
      >
        <ShownKey plaintext={create.data.plaintext_key} onDone={close} />
      </Dialog>
    );
  }
  const failure = create.error
    ? (`errors.${['invalid_input', 'invalid_scope', 'permission_denied', 'not_found'].includes(create.error.message) ? create.error.message : 'unknown'}` as 'errors.unknown')
    : null;
  return (
    <Dialog open={open} onClose={close} title={t('create.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('create.name')}
          hint={t('create.nameHint')}
          maxLength={80}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('create.scopes')}</legend>
          {API_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              label={t(`scope.${scopeKey(scope)}.name`)}
              hint={t(`scope.${scopeKey(scope)}.help`)}
              checked={scopes.includes(scope)}
              onChange={(event) =>
                setScopes((now) =>
                  event.target.checked ? [...now, scope] : now.filter((s) => s !== scope),
                )
              }
            />
          ))}
        </fieldset>
        {orgLocations.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">{t('create.locations')}</legend>
            <Checkbox
              label={t('list.allLocations')}
              checked={picked === null}
              onChange={() => setPicked(null)}
            />
            {orgLocations.map((location) => (
              <Checkbox
                key={location.id}
                label={location.name}
                checked={picked?.includes(location.id) ?? false}
                onChange={(event) =>
                  setPicked((now) =>
                    event.target.checked
                      ? [...(now ?? []), location.id]
                      : (now ?? []).filter((id) => id !== location.id),
                  )
                }
              />
            ))}
          </fieldset>
        ) : null}
        <Select
          label={t('create.expiry')}
          value={expiry}
          onChange={(event) => setExpiry(event.target.value as (typeof EXPIRY_DAYS)[number])}
        >
          {EXPIRY_DAYS.map((days) => (
            <option key={days} value={days}>
              {t(`create.expiryOption.${days}`)}
            </option>
          ))}
        </Select>
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {failure ? t(failure) : null}
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={close}>
            {t('create.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={scopes.length === 0 || (picked !== null && picked.length === 0)}
            loading={create.isPending}
            loadingLabel={t('create.creating')}
          >
            {t('create.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ShownKey({ plaintext, onDone }: { plaintext: string; onDone: () => void }) {
  const { t } = useTranslation('admin-api-keys');
  const [copied, setCopied] = useState(false);
  const [stored, setStored] = useState(false);
  const copy = async () => {
    // The clipboard needs a secure context; the field stays selectable either way.
    await navigator.clipboard?.writeText(plaintext).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="shown-key">
      <Input
        label={t('shown.label')}
        readOnly
        value={plaintext}
        className="font-mono"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button variant="secondary" onClick={() => void copy()}>
        {copied ? t('shown.copied') : t('shown.copy')}
      </Button>
      <Checkbox
        label={t('shown.stored')}
        checked={stored}
        onChange={(event) => setStored(event.target.checked)}
      />
      <div className="flex justify-end">
        <Button disabled={!stored} onClick={onDone}>
          {t('shown.done')}
        </Button>
      </div>
    </div>
  );
}
