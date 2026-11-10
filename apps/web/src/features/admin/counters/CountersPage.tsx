import {
  Badge,
  Button,
  Card,
  ConfirmDestructive,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { canManageQueues } from '../queues/api.ts';
import { membersQuery } from '../team/api.ts';
import {
  countersQuery,
  NEW_RESOURCE,
  RESOURCE_KINDS,
  useChangeCounter,
  type CounterRow,
  type ResourceSettings,
} from './api.ts';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input'];

/** The current location's resources of every kind: list, add, edit and archive (A7, #47; 2A-Q3). */
export function CountersPage() {
  const { t } = useTranslation('admin');
  const { t: te } = useTranslation('empty');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const query = useQuery({ ...countersQuery(location?.id ?? ''), enabled: !!location });
  const change = useChangeCounter({
    orgId: location?.org_id ?? '',
    locationId: location?.id ?? '',
  });
  // 'new', a counter id, or null: which form is open.
  const [editing, setEditing] = useState<string | null>(null);
  if (!location || !query.data) return <Skeleton label={t('counters.loading')} rows={2} />;

  const canManage = canManageQueues(org?.role);
  const failure = change.error
    ? `errors.${KNOWN_ERRORS.includes(change.error.message) ? change.error.message : 'unknown'}`
    : null;
  const open = (id: string | null) => {
    change.reset();
    setEditing(id);
  };
  const close = { onSuccess: () => setEditing(null) };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('counters.title')}
        description={t('counters.intro')}
        actions={
          canManage && editing !== 'new' ? (
            <Button onClick={() => open('new')}>{t('counters.add')}</Button>
          ) : null
        }
      />
      {canManage ? null : <p className="text-muted">{t('queues.readOnly')}</p>}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      {editing === 'new' ? (
        <ResourceForm
          initial={NEW_RESOURCE}
          pending={change.isPending}
          onCancel={() => open(null)}
          onSave={(settings) => change.mutate({ kind: 'create', settings }, close)}
        />
      ) : null}
      {query.data.length === 0 && editing !== 'new' ? (
        <ScreenEmpty
          kind="counters"
          action={
            canManage ? (
              <Button onClick={() => open('new')}>{te('counters.add')}</Button>
            ) : undefined
          }
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {query.data.map((counter) => (
          <li key={counter.id}>
            {editing === counter.id ? (
              <ResourceForm
                initial={counter}
                pending={change.isPending}
                onCancel={() => open(null)}
                onSave={(settings) =>
                  change.mutate({ kind: 'update', id: counter.id, settings }, close)
                }
              />
            ) : (
              <CounterSummary
                counter={counter}
                canManage={canManage}
                onRename={() => open(counter.id)}
                onArchive={() =>
                  // A failure shows in the alert above; the dialog just closes.
                  change.mutateAsync({ kind: 'archive', id: counter.id }).catch(() => {})
                }
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CounterSummary({
  counter,
  canManage,
  onRename,
  onArchive,
}: {
  counter: CounterRow;
  canManage: boolean;
  onRename: () => void;
  onArchive: () => Promise<unknown>;
}) {
  const { t } = useTranslation('admin');
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3" data-testid="counter">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{counter.label}</h2>
        <Badge tone="neutral">{t(`counters.kinds.${counter.kind}`)}</Badge>
        {counter.seats ? (
          <span className="text-sm text-muted">
            {t('counters.seats', { count: counter.seats })}
          </span>
        ) : null}
      </div>
      {canManage ? (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onRename}>
            {t('counters.edit')}
          </Button>
          <ConfirmDestructive
            triggerVariant="secondary"
            triggerLabel={t('counters.archive')}
            title={t('counters.archiveTitle', { label: counter.label })}
            description={t('counters.archiveDescription')}
            confirmLabel={t('counters.archiveConfirm')}
            cancelLabel={t('counters.archiveCancel')}
            onConfirm={onArchive}
          />
        </div>
      ) : null}
    </Card>
  );
}

function ResourceForm({
  initial,
  pending,
  onCancel,
  onSave,
}: {
  initial: ResourceSettings;
  pending: boolean;
  onCancel: () => void;
  onSave: (settings: ResourceSettings) => void;
}) {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const [r, setR] = useState<ResourceSettings>({
    label: initial.label,
    kind: initial.kind,
    seats: initial.seats,
    memberUserId: initial.memberUserId,
  });
  const members = useQuery({
    ...membersQuery(org?.id ?? ''),
    enabled: !!org && r.kind === 'staff',
  });
  const here = (members.data ?? []).filter(
    (m) => !m.locationIds || (location && m.locationIds.includes(location.id)),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (r.kind === 'staff' && !r.memberUserId) return;
    onSave(r);
  };
  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('counters.label')}
          hint={t('counters.labelHint')}
          required
          maxLength={40}
          pattern=".*\S.*"
          value={r.label}
          onChange={(event) => setR((v) => ({ ...v, label: event.target.value }))}
        />
        <Select
          label={t('counters.kind')}
          value={r.kind}
          onChange={(event) =>
            setR((v) => ({ ...v, kind: event.target.value as ResourceSettings['kind'] }))
          }
        >
          {RESOURCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`counters.kinds.${kind}`)}
            </option>
          ))}
        </Select>
        {r.kind === 'table' ? (
          <Input
            label={t('counters.seatsLabel')}
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            required
            value={r.seats === null ? '' : String(r.seats)}
            onChange={(event) =>
              setR((v) => ({ ...v, seats: event.target.value ? Number(event.target.value) : null }))
            }
          />
        ) : null}
        {r.kind === 'staff' ? (
          <Select
            label={t('counters.member')}
            required
            value={r.memberUserId ?? ''}
            onChange={(event) => setR((v) => ({ ...v, memberUserId: event.target.value || null }))}
          >
            <option value="">{t('counters.memberPick')}</option>
            {here.map((m) => (
              <option key={m.userId} value={m.userId ?? ''}>
                {m.displayName ?? m.email ?? t('counters.memberUnnamed')}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {t('queues.cancel')}
          </Button>
          <Button type="submit" loading={pending} loadingLabel={t('queues.saving')}>
            {t('counters.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
