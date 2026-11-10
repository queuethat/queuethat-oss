import {
  Button,
  Card,
  Checkbox,
  ConfirmDestructive,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { canManageQueues, queuesQuery } from '../queues/api.ts';
import {
  journeysQuery,
  useDeleteJourney,
  useSaveJourney,
  type JourneyRow,
  type JourneyService,
} from './api.ts';

/** Q-12 (#234): linear journeys, queue by queue, and the services whose guests follow them. */
export function JourneysPage() {
  const { t } = useTranslation('admin-journeys');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const journeys = useQuery({ ...journeysQuery(location?.id ?? ''), enabled: !!location });
  const queues = useQuery({ ...queuesQuery(location?.id ?? ''), enabled: !!location });
  const remove = useDeleteJourney(location?.id ?? '');
  const [editing, setEditing] = useState<string | null>(null);
  if (!location || !org || !journeys.data || !queues.data)
    return <Skeleton label={t('loading')} rows={2} />;
  const canManage = canManageQueues(org.role);
  const nameOf = (id: string) => queues.data.find((q) => q.id === id)?.name ?? '';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <PageHeader
        title={t('title')}
        description={t('intro')}
        actions={
          canManage && editing !== 'new' ? (
            <Button onClick={() => setEditing('new')}>{t('add')}</Button>
          ) : null
        }
      />
      {editing === 'new' ? (
        <JourneyForm
          orgId={org.id}
          locationId={location.id}
          queues={queues.data}
          services={journeys.data.services}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {journeys.data.journeys.length === 0 && editing !== 'new' ? (
        <p className="text-muted">{t('empty')}</p>
      ) : null}
      {journeys.data.journeys.map((j) =>
        editing === j.id ? (
          <JourneyForm
            key={j.id}
            journey={j}
            orgId={org.id}
            locationId={location.id}
            queues={queues.data}
            services={journeys.data.services}
            onDone={() => setEditing(null)}
          />
        ) : (
          <Card
            key={j.id}
            className="flex flex-wrap items-center justify-between gap-3"
            data-testid="journey"
          >
            <div>
              <h2 className="text-lg font-semibold">{j.name}</h2>
              <p className="text-muted">{j.steps.map((s) => nameOf(s.queueId)).join(' → ')}</p>
              <p className="text-sm text-muted">
                {t('services', {
                  list:
                    journeys.data.services
                      .filter((s) => j.serviceIds.includes(s.id))
                      .map((s) => s.name)
                      .join(', ') || t('noServices'),
                })}
              </p>
            </div>
            {canManage ? (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEditing(j.id)}>
                  {t('edit')}
                </Button>
                <ConfirmDestructive
                  triggerVariant="secondary"
                  triggerLabel={t('delete')}
                  title={t('deleteTitle', { name: j.name })}
                  description={t('deleteBody')}
                  confirmLabel={t('deleteConfirm')}
                  cancelLabel={t('cancel')}
                  onConfirm={() => remove.mutateAsync(j.id)}
                />
              </div>
            ) : null}
          </Card>
        ),
      )}
    </div>
  );
}

function JourneyForm({
  journey,
  orgId,
  locationId,
  queues,
  services,
  onDone,
}: {
  journey?: JourneyRow;
  orgId: string;
  locationId: string;
  queues: { id: string; name: string }[];
  services: JourneyService[];
  onDone: () => void;
}) {
  const { t } = useTranslation('admin-journeys');
  const save = useSaveJourney(orgId, locationId);
  const [name, setName] = useState(journey?.name ?? '');
  const [steps, setSteps] = useState<string[]>(journey?.steps.map((s) => s.queueId) ?? ['', '']);
  const [serviceIds, setServiceIds] = useState<string[]>(journey?.serviceIds ?? []);
  const chosen = steps.filter(Boolean);
  const duplicate = new Set(chosen).size !== chosen.length;
  const valid =
    name.trim() !== '' && chosen.length === steps.length && steps.length >= 2 && !duplicate;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    save.mutate(
      { id: journey?.id, name: name.trim(), queueIds: steps, serviceIds },
      { onSuccess: onDone },
    );
  };
  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Input
          label={t('name')}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <ol className="flex flex-col gap-2">
          {steps.map((queueId, i) => (
            <li key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Select
                  label={t('step', { n: i + 1 })}
                  value={queueId}
                  onChange={(e) => setSteps(steps.map((s, j) => (j === i ? e.target.value : s)))}
                >
                  <option value="">{t('pickQueue')}</option>
                  {queues.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.name}
                    </option>
                  ))}
                </Select>
              </div>
              {steps.length > 2 ? (
                <Button
                  variant="secondary"
                  aria-label={t('removeStep', { n: i + 1 })}
                  onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                >
                  {t('remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        <div>
          <Button variant="secondary" onClick={() => setSteps([...steps, ''])}>
            {t('addStep')}
          </Button>
        </div>
        {duplicate ? (
          <p role="alert" className="text-danger-strong">
            {t('duplicate')}
          </p>
        ) : null}
        <fieldset className="flex flex-col">
          <legend className="font-medium">{t('forServices')}</legend>
          {services.map((s) => (
            <Checkbox
              key={s.id}
              label={`${s.name} · ${s.queueName}`}
              checked={serviceIds.includes(s.id)}
              onChange={(e) =>
                setServiceIds(
                  e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((x) => x !== s.id),
                )
              }
            />
          ))}
        </fieldset>
        {save.isError ? (
          <p role="alert" className="text-danger-strong">
            {t('saveFailed')}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={!valid}
            loading={save.isPending}
            loadingLabel={t('saving')}
          >
            {t('save')}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
