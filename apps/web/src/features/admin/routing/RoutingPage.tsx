import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { canManageQueues } from '../queues/api.ts';
import {
  routingQuery,
  useChangeRouting,
  type NewRoutingRule,
  type RoutingField,
  type RoutingQueue,
  type RoutingService,
} from './api.ts';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input'];

/** The location's routing rules: which queue a guest joining the location lands in (Q-11). */
export function RoutingPage() {
  const { t } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const role = useCurrentOrg()?.role;
  const query = useQuery({ ...routingQuery(location?.id ?? ''), enabled: !!location });
  const change = useChangeRouting({
    orgId: location?.org_id ?? '',
    locationId: location?.id ?? '',
  });
  const [adding, setAdding] = useState(false);
  if (!location || !query.data) return <Skeleton label={t('routing.loading')} rows={2} />;
  const { rules, queues, services, fields } = query.data;
  const canManage = canManageQueues(role);
  const failure = change.error
    ? `errors.${KNOWN_ERRORS.includes(change.error.message) ? change.error.message : 'unknown'}`
    : null;
  const ids = rules.map((r) => r.id);
  const move = (from: number, to: number) => {
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    change.mutate({ kind: 'reorder', ids: next });
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-8">
      <Link
        to="/admin/queues"
        className="inline-flex min-h-target items-center font-medium text-primary underline"
      >
        {t('services.back')}
      </Link>
      <PageHeader
        title={t('routing.title')}
        description={t('routing.intro')}
        actions={
          canManage && !adding && queues.length > 0 ? (
            <Button onClick={() => setAdding(true)}>{t('routing.add')}</Button>
          ) : null
        }
      />
      {canManage ? null : <p className="text-muted">{t('queues.readOnly')}</p>}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      {adding ? (
        <RuleForm
          queues={queues}
          services={services}
          fields={fields}
          pending={change.isPending}
          onCancel={() => setAdding(false)}
          onSave={(rule) =>
            change.mutate(
              { kind: 'create', rule, rank: rules.length },
              { onSuccess: () => setAdding(false) },
            )
          }
        />
      ) : null}
      {rules.length === 0 && !adding ? (
        <EmptyState title={t('routing.empty')} description={t('routing.emptyHint')} />
      ) : null}
      <ol className="flex flex-col gap-3">
        {rules.map((r, i) => {
          const service = services.find((s) => s.id === r.serviceId);
          const field = fields.find((f) => f.id === r.fieldId);
          const target = queues.find((q) => q.id === r.targetQueueId)?.name ?? '';
          const condition = [
            service ? t('routing.ifService', { name: service.name }) : t('routing.anyService'),
            field ? t('routing.ifAnswer', { question: field.label, answer: r.answerValue }) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={r.id}>
              <Card
                className="flex flex-wrap items-center justify-between gap-3"
                data-testid="routing-rule"
              >
                <div>
                  <p className="font-semibold">
                    {t('routing.rule', { position: i + 1, condition, target })}
                  </p>
                  {r.active ? null : <Badge tone="neutral">{t('routing.off')}</Badge>}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={i === 0 || change.isPending}
                      aria-label={t('routing.moveUp', { position: i + 1 })}
                      onClick={() => move(i, i - 1)}
                    >
                      {t('routing.up')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={i === rules.length - 1 || change.isPending}
                      aria-label={t('routing.moveDown', { position: i + 1 })}
                      onClick={() => move(i, i + 1)}
                    >
                      {t('routing.down')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={change.isPending}
                      onClick={() =>
                        change.mutate({ kind: 'setActive', id: r.id, active: !r.active })
                      }
                    >
                      {r.active ? t('routing.switchOff') : t('routing.switchOn')}
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-muted">{t('routing.order')}</p>
    </div>
  );
}

function RuleForm({
  queues,
  services,
  fields,
  pending,
  onCancel,
  onSave,
}: {
  queues: RoutingQueue[];
  services: RoutingService[];
  fields: RoutingField[];
  pending: boolean;
  onCancel: () => void;
  onSave: (rule: NewRoutingRule) => void;
}) {
  const { t } = useTranslation('admin');
  const [serviceId, setServiceId] = useState('');
  const [targetQueueId, setTargetQueueId] = useState(queues[0]?.id ?? '');
  const [fieldId, setFieldId] = useState('');
  const [answer, setAnswer] = useState('');
  // An answer condition names a question the guest meets on the target queue's own form.
  const questions = fields.filter((f) => f.queueId === targetQueueId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const field = questions.some((f) => f.id === fieldId) ? fieldId : null;
    onSave({ serviceId: serviceId || null, fieldId: field, answerValue: answer, targetQueueId });
  };
  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-lg font-semibold">{t('routing.newRule')}</h2>
        <Select
          label={t('routing.service')}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">{t('routing.anyService')}</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {`${s.name} (${s.queueName})`}
            </option>
          ))}
        </Select>
        <Select
          label={t('routing.target')}
          value={targetQueueId}
          onChange={(e) => {
            setTargetQueueId(e.target.value);
            setFieldId('');
          }}
        >
          {queues.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </Select>
        {questions.length > 0 ? (
          <Select
            label={t('routing.question')}
            hint={t('routing.questionHint')}
            value={fieldId}
            onChange={(e) => setFieldId(e.target.value)}
          >
            <option value="">{t('routing.noQuestion')}</option>
            {questions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        ) : null}
        {fieldId ? (
          <Input
            label={t('routing.answer')}
            required
            maxLength={200}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        ) : null}
        <div className="flex justify-between gap-4">
          <Button variant="secondary" onClick={onCancel}>
            {t('routing.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('routing.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
