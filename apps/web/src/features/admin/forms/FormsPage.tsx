import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { canManageQueues } from '../queues/api.ts';
import {
  CHANNELS,
  FORM_LIMIT,
  formsQuery,
  healthTaggedQuery,
  placementsQuery,
  useChangeForms,
  type Channel,
  type FormRow,
  type Placement,
} from './api.ts';
import { EditorMount } from './EditorMount.tsx';
import { WaiverExport } from './waivers/WaiverExport.tsx';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input', 'not_found'];

/** The location's forms: create, edit (new version for every target on publish), attach, detach. */
export function FormsPage() {
  const { t } = useTranslation('admin-forms');
  const toast = useToast();
  const role = useCurrentOrg()?.role;
  const org = useCurrentOrg();
  const { location } = useCurrentLocation();
  const forms = useQuery({ ...formsQuery(location?.id ?? ''), enabled: !!location });
  const health = useQuery({ ...healthTaggedQuery(org?.id ?? ''), enabled: !!org });
  const places = useQuery({ ...placementsQuery(location?.id ?? ''), enabled: !!location });
  const change = useChangeForms({ id: org?.id ?? '', locationId: location?.id ?? '' });
  // 'new', a form id, or null; attaching names the form whose attach panel is open.
  const [editing, setEditing] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  if (!location || !org || !forms.data || !places.data) {
    return <Skeleton label={t('loading')} rows={2} />;
  }
  const canManage = canManageQueues(role);
  const library = forms.data.filter((f) => !f.isQueueDefault).length;
  const failure = change.error
    ? `errors.${KNOWN_ERRORS.includes(change.error.message) ? change.error.message : 'unknown'}`
    : null;
  const nameOf = (p: { targetId: string }) =>
    places.data.find((x) => x.id === p.targetId)?.name ?? t('unknownPlace');
  const detach = (form: FormRow, targetId: string, scope: Channel) =>
    change.mutate(
      { kind: 'detach', formId: form.id, targetIds: [targetId], scope },
      {
        onSuccess: () =>
          toast.undo(t('detached'), () =>
            change.mutate({ kind: 'attach', formId: form.id, targetIds: [targetId], scope }),
          ),
      },
    );
  const open = form(editing, forms.data);

  return (
    <div
      className={`mx-auto flex flex-col gap-4 pb-8 ${editing === null ? 'max-w-2xl' : 'max-w-5xl'}`}
    >
      <PageHeader
        title={t('title')}
        description={t('intro')}
        actions={
          canManage && editing === null ? (
            <Button disabled={library >= FORM_LIMIT} onClick={() => setEditing('new')}>
              {t('new')}
            </Button>
          ) : null
        }
      />
      {canManage ? null : <p className="text-muted">{t('readOnly')}</p>}
      {library >= FORM_LIMIT ? (
        <p className="text-sm text-muted">{t('limit', { count: FORM_LIMIT })}</p>
      ) : null}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      {editing !== null ? (
        <Card>
          <h2 className="mb-4 text-lg font-semibold">{open ? open.name : t('newHeading')}</h2>
          <EditorMount
            key={editing}
            form={open}
            healthTagged={health.data ?? false}
            pending={change.isPending}
            onCancel={() => setEditing(null)}
            onSave={(save) =>
              change.mutate(
                { kind: 'save', formId: open?.id ?? null, ...save },
                { onSuccess: () => setEditing(null) },
              )
            }
          />
        </Card>
      ) : forms.data.length === 0 ? (
        <EmptyState title={t('empty')} description={t('emptyHint')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {forms.data.map((f) => (
            <li key={f.id}>
              <Card className="flex flex-col gap-3" data-testid="form-card">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{f.name}</h2>
                    <p className="text-sm text-muted">
                      {f.liveVersion === null
                        ? t('neverPublished')
                        : t('version', { version: f.liveVersion })}
                      {' · '}
                      {t('questions', { count: f.fields.length })}
                    </p>
                    {f.hasDraft ? <Badge tone="warning">{t('draftPending')}</Badge> : null}
                    {f.isQueueDefault ? <Badge tone="neutral">{t('queueDefault')}</Badge> : null}
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => setEditing(f.id)}>
                        {t('edit')}
                      </Button>
                      {f.liveVersion !== null && !f.isQueueDefault ? (
                        <Button
                          variant="secondary"
                          onClick={() => setAttaching(attaching === f.id ? null : f.id)}
                        >
                          {t('attach')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <ShownOn
                  form={f}
                  nameOf={nameOf}
                  canManage={canManage}
                  pending={change.isPending}
                  onDetach={detach}
                />
                {attaching === f.id ? (
                  <AttachPanel
                    form={f}
                    places={places.data}
                    pending={change.isPending}
                    onAttach={(targetIds, scope) =>
                      change.mutate(
                        { kind: 'attach', formId: f.id, targetIds, scope },
                        { onSuccess: () => setAttaching(null) },
                      )
                    }
                  />
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {canManage && editing === null ? <WaiverExport /> : null}
    </div>
  );
}

const form = (id: string | null, all: FormRow[]) => all.find((f) => f.id === id) ?? null;

function ShownOn({
  form,
  nameOf,
  canManage,
  pending,
  onDetach,
}: {
  form: FormRow;
  nameOf: (t: { targetId: string }) => string;
  canManage: boolean;
  pending: boolean;
  onDetach: (form: FormRow, targetId: string, scope: Channel) => void;
}) {
  const { t } = useTranslation('admin-forms');
  if (form.targets.length === 0) return <p className="text-sm text-muted">{t('shownNowhere')}</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label={t('shownOn')}>
      {form.targets.map((target) => (
        <li
          key={`${target.targetId}:${target.scope}`}
          className="flex items-center justify-between gap-2"
        >
          <span>
            {nameOf(target)}{' '}
            <span className="text-sm text-muted">({t(`scope.${target.scope}`)})</span>
          </span>
          {canManage && !form.isQueueDefault ? (
            <Button
              variant="secondary"
              disabled={pending}
              aria-label={t('detachNamed', { name: nameOf(target) })}
              onClick={() => onDetach(form, target.targetId, target.scope)}
            >
              {t('detach')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AttachPanel({
  form,
  places,
  pending,
  onAttach,
}: {
  form: FormRow;
  places: Placement[];
  pending: boolean;
  onAttach: (targetIds: string[], scope: Channel) => void;
}) {
  const { t } = useTranslation('admin-forms');
  const [picked, setPicked] = useState<string[]>([]);
  const [scope, setChannel] = useState<Channel>('any');
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <fieldset className="flex flex-col gap-3 border-t border-line pt-3">
      <legend className="font-medium">{t('attachTitle', { name: form.name })}</legend>
      <Select
        label={t('channelLabel')}
        value={scope}
        onChange={(e) => setChannel(e.target.value as Channel)}
      >
        {CHANNELS.map((c) => (
          <option key={c} value={c}>
            {t(`scope.${c}`)}
          </option>
        ))}
      </Select>
      {places.map((p) => (
        <Checkbox
          key={p.id}
          label={p.name}
          checked={picked.includes(p.id)}
          onChange={() => toggle(p.id)}
        />
      ))}
      <Button
        disabled={picked.length === 0 || pending}
        loading={pending}
        loadingLabel={t('attaching')}
        onClick={() => onAttach(picked, scope)}
      >
        {t('attachSubmit', { count: picked.length })}
      </Button>
    </fieldset>
  );
}
