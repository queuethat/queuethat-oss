import { Badge, Button, Card, Checkbox, EmptyState, Input, PageHeader, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { BookingSettings } from '../booking/BookingSettings.tsx';
import { PaymentSettings } from '../payments/PaymentSettings.tsx';
import { SWATCH_SERVICE } from '../swatch.ts';
import { countersQuery, RESOURCE_KINDS, type CounterRow } from '../counters/api.ts';
import { canManageQueues } from '../queues/api.ts';
import {
  NEW_SERVICE,
  queueServicesQuery,
  useChangeService,
  type ServiceRow,
  type ServiceSettings,
} from './api.ts';

const KNOWN_ERRORS = ['permission_denied'];

/** One queue's services: list, add, edit, deactivate and reactivate (A6, #46). */
export function ServicesPage({ queueId }: { queueId: string }) {
  const { t } = useTranslation('admin');
  const role = useCurrentOrg()?.role;
  const query = useQuery(queueServicesQuery(queueId));
  if (!query.data) return <Skeleton label={t('services.loading')} rows={2} />;
  return (
    <ServiceList
      queue={query.data.queue}
      services={query.data.services}
      canManage={canManageQueues(role)}
    />
  );
}

function ServiceList({
  queue,
  services,
  canManage,
}: {
  queue: { id: string; orgId: string; locationId: string; name: string; ticketPrefix: string };
  services: ServiceRow[];
  canManage: boolean;
}) {
  const { t } = useTranslation('admin');
  const change = useChangeService(queue);
  const { location } = useCurrentLocation();
  const resources = useQuery({ ...countersQuery(queue.locationId) }).data ?? [];
  // 'new', a service id, or null: which form is open.
  const [editing, setEditing] = useState<string | null>(null);
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
      <Link
        to="/admin/queues"
        className="inline-flex min-h-target items-center font-medium text-primary underline"
      >
        {t('services.back')}
      </Link>
      <PageHeader
        title={t('services.title', { queue: queue.name })}
        actions={
          canManage && editing !== 'new' ? (
            <Button onClick={() => open('new')}>{t('services.add')}</Button>
          ) : null
        }
      />
      {canManage ? null : <p className="text-muted">{t('queues.readOnly')}</p>}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      {editing === 'new' ? (
        <ServiceForm
          heading={t('services.newHeading')}
          initial={NEW_SERVICE}
          resources={resources}
          queuePrefix={queue.ticketPrefix}
          pending={change.isPending}
          onCancel={() => open(null)}
          onSave={(settings) => change.mutate({ kind: 'create', settings }, close)}
        />
      ) : null}
      {services.length === 0 && editing !== 'new' ? (
        <EmptyState title={t('services.empty')} description={t('services.emptyHint')} />
      ) : null}
      <ul className="flex flex-col gap-3">
        {services.map((service) =>
          editing === `booking:${service.id}` && location ? (
            <li key={service.id}>
              <BookingSettings
                service={service}
                org={{
                  orgId: queue.orgId,
                  locationId: queue.locationId,
                  slug: location.slug,
                  tz: location.tz,
                }}
                canManage={canManage}
                onClose={() => open(null)}
              />
            </li>
          ) : editing === `payments:${service.id}` ? (
            <li key={service.id}>
              <PaymentSettings
                service={service}
                org={{ orgId: queue.orgId, locationId: queue.locationId }}
                canManage={canManage}
                onClose={() => open(null)}
              />
            </li>
          ) : editing === service.id ? (
            <li key={service.id}>
              <ServiceForm
                heading={t('services.editHeading', { name: service.name })}
                initial={service}
                resources={resources}
                queuePrefix={queue.ticketPrefix}
                pending={change.isPending}
                onCancel={() => open(null)}
                onSave={(settings) =>
                  change.mutate({ kind: 'update', id: service.id, settings }, close)
                }
              />
            </li>
          ) : (
            <li key={service.id}>
              <ServiceSummary
                service={service}
                resources={resources}
                canManage={canManage}
                pending={change.isPending}
                onEdit={() => open(service.id)}
                onBooking={() => open(`booking:${service.id}`)}
                onPayments={() => open(`payments:${service.id}`)}
                onSetActive={(active) =>
                  change.mutate({ kind: 'setActive', id: service.id, active })
                }
              />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function ServiceSummary({
  service,
  resources,
  canManage,
  pending,
  onEdit,
  onBooking,
  onPayments,
  onSetActive,
}: {
  service: ServiceRow;
  resources: CounterRow[];
  canManage: boolean;
  pending: boolean;
  onEdit: () => void;
  onBooking: () => void;
  onPayments: () => void;
  onSetActive: (active: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const servedBy = resources.filter((r) => service.resourceIds.includes(r.id)).map((r) => r.label);
  const swatch = { backgroundColor: service.color ?? 'transparent' };
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3" data-testid="service">
      <div className="flex items-center gap-3">
        <span aria-hidden className="size-4 rounded-full border border-border" style={swatch} />
        <div>
          <h2 className="text-lg font-semibold">{service.name}</h2>
          <p className="text-sm text-muted">
            {t('services.minutes', { count: service.expectedMinutes })}
          </p>
          {servedBy.length > 0 ? (
            <p className="text-sm text-muted">
              {t('services.servedBy', { names: servedBy.join(', ') })}
            </p>
          ) : null}
        </div>
        {service.active ? null : <Badge tone="neutral">{t('services.inactive')}</Badge>}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onBooking}>
          {t('services.booking')}
        </Button>
        <Button variant="secondary" onClick={onPayments}>
          {t('services.payments')}
        </Button>
      </div>
      {canManage ? (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onEdit}>
            {t('services.edit')}
          </Button>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => onSetActive(!service.active)}
          >
            {service.active ? t('services.deactivate') : t('services.reactivate')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function ServiceForm({
  heading,
  initial,
  resources,
  queuePrefix,
  pending,
  onCancel,
  onSave,
}: {
  heading: string;
  initial: ServiceSettings;
  resources: CounterRow[];
  queuePrefix: string;
  pending: boolean;
  onCancel: () => void;
  onSave: (settings: ServiceSettings) => void;
}) {
  const { t } = useTranslation('admin');
  const [s, setS] = useState(initial);
  const text = (key: 'name' | 'description') => ({
    value: s[key],
    onChange: (event: { target: { value: string } }) =>
      setS((v) => ({ ...v, [key]: event.target.value })),
  });
  const fields = { name: text('name'), description: text('description') };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(s);
  };

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-lg font-semibold">{heading}</h2>
        <Input
          label={t('services.name')}
          required
          maxLength={80}
          pattern=".*\S.*"
          {...fields.name}
        />
        <Input
          label={t('services.description')}
          hint={t('services.descriptionHint')}
          maxLength={200}
          {...fields.description}
        />
        <Input
          label={t('services.expectedMinutes')}
          hint={t('services.expectedMinutesHint')}
          type="number"
          inputMode="numeric"
          min={1}
          max={600}
          required
          value={String(s.expectedMinutes)}
          onChange={(event) => setS((v) => ({ ...v, expectedMinutes: Number(event.target.value) }))}
        />
        <Input
          label={t('services.ticketPrefix')}
          hint={t('services.ticketPrefixHint', {
            queue: queuePrefix,
            example: `${s.ticketPrefix.trim().toUpperCase() || queuePrefix}001`,
          })}
          maxLength={3}
          pattern="[A-Za-z]{0,3}"
          autoCapitalize="characters"
          value={s.ticketPrefix}
          onChange={(event) => setS((v) => ({ ...v, ticketPrefix: event.target.value }))}
        />
        <Input
          label={t('services.color')}
          type="color"
          className="w-24"
          value={s.color ?? SWATCH_SERVICE}
          onChange={(event) => setS((v) => ({ ...v, color: event.target.value }))}
        />
        {resources.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">{t('services.servedByLabel')}</legend>
            <p className="text-sm text-muted">{t('services.servedByHint')}</p>
            {RESOURCE_KINDS.map((kind) => {
              const ofKind = resources.filter((r) => r.kind === kind);
              return ofKind.length === 0 ? null : (
                <div key={kind} role="group" aria-label={t(`counters.kinds.${kind}`)}>
                  <p className="text-sm font-semibold text-muted">{t(`counters.kinds.${kind}`)}</p>
                  {ofKind.map((r) => (
                    <Checkbox
                      key={r.id}
                      label={r.label}
                      checked={s.resourceIds.includes(r.id)}
                      onChange={(event) =>
                        setS((v) => ({
                          ...v,
                          resourceIds: event.target.checked
                            ? [...v.resourceIds, r.id]
                            : v.resourceIds.filter((id) => id !== r.id),
                        }))
                      }
                    />
                  ))}
                </div>
              );
            })}
          </fieldset>
        ) : null}
        <Checkbox
          label={t('services.active')}
          hint={t('services.activeHint')}
          checked={s.active}
          onChange={(event) => setS((v) => ({ ...v, active: event.target.checked }))}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {t('queues.cancel')}
          </Button>
          <Button type="submit" loading={pending} loadingLabel={t('queues.saving')}>
            {t('services.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
