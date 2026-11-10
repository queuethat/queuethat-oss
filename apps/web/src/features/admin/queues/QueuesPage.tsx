import {
  Button,
  Card,
  Checkbox,
  ConfirmDestructive,
  Disclosure,
  Input,
  LinkButton,
  Select,
  PageHeader,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../components/ScreenEmpty.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import {
  ASSIGNMENT_STRATEGIES,
  canManageQueues,
  NEW_QUEUE,
  policyProblem,
  queuesQuery,
  smsKeywordProblem,
  useChangeQueue,
  JOIN_RESTRICTIONS,
  type AssignmentStrategy,
  type JoinRestriction,
  type QueueRow,
  type QueueSettings,
} from './api.ts';
import { SingleActiveVisit } from '../org/SingleActiveVisit.tsx';
import { GuestAlerts } from './alerts/GuestAlerts.tsx';

const PREFIX = /^[A-Z]{1,3}$/;
const KNOWN_ERRORS = ['permission_denied', 'keyword_taken', 'keyword_invalid'];

/** The current location's queues: list, create, edit and archive (A5, #45). */
export function QueuesPage() {
  const { t } = useTranslation('admin');
  const { t: te } = useTranslation('empty');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const query = useQuery({ ...queuesQuery(location?.id ?? ''), enabled: !!location });
  const change = useChangeQueue({ orgId: location?.org_id ?? '', locationId: location?.id ?? '' });
  // 'new', a queue id, or null: which form is open.
  const [editing, setEditing] = useState<string | null>(null);
  if (!location || !query.data) return <Skeleton label={t('queues.loading')} rows={2} />;

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
        title={t('queues.title')}
        actions={
          <>
            <LinkButton
              variant="secondary"
              render={(p) => <Link to="/admin/queues/priority" {...p} />}
            >
              {t('queues.priorityLink')}
            </LinkButton>
            <LinkButton variant="secondary" render={(p) => <Link to="/admin/routing" {...p} />}>
              {t('queues.routingLink')}
            </LinkButton>
            {canManage && editing !== 'new' ? (
              <Button onClick={() => open('new')}>{t('queues.add')}</Button>
            ) : null}
          </>
        }
      />
      {canManage ? null : <p className="text-muted">{t('queues.readOnly')}</p>}
      {org ? (
        <SingleActiveVisit orgId={org.id} canEdit={org.role === 'owner' || org.role === 'admin'} />
      ) : null}
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      {editing === 'new' ? (
        <QueueForm
          heading={t('queues.newHeading')}
          initial={NEW_QUEUE}
          others={query.data.map((x) => x.smsKeyword)}
          pending={change.isPending}
          onCancel={() => open(null)}
          onSave={(settings) => change.mutate({ kind: 'create', settings }, close)}
        />
      ) : null}
      {query.data.length === 0 && editing !== 'new' ? (
        <ScreenEmpty
          kind="queues"
          action={
            canManage ? <Button onClick={() => open('new')}>{te('queues.add')}</Button> : undefined
          }
          secondary={
            canManage ? (
              <LinkButton variant="secondary" render={(p) => <Link to="/admin/templates" {...p} />}>
                {te('queues.template')}
              </LinkButton>
            ) : undefined
          }
        />
      ) : null}
      <ul className="flex flex-col gap-3">
        {query.data.map((queue) => (
          <li key={queue.id}>
            {editing === queue.id ? (
              <QueueForm
                heading={t('queues.editHeading', { name: queue.name })}
                initial={queue}
                others={query.data.filter((x) => x.id !== queue.id).map((x) => x.smsKeyword)}
                pending={change.isPending}
                onCancel={() => open(null)}
                onSave={(settings) =>
                  change.mutate({ kind: 'update', id: queue.id, settings }, close)
                }
              />
            ) : (
              <QueueSummary
                queue={queue}
                canManage={canManage}
                onEdit={() => open(queue.id)}
                onArchive={() =>
                  // A failure shows in the alert above; the dialog just closes.
                  change.mutateAsync({ kind: 'archive', id: queue.id }).catch(() => {})
                }
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function QueueSummary({
  queue,
  canManage,
  onEdit,
  onArchive,
}: {
  queue: QueueRow;
  canManage: boolean;
  onEdit: () => void;
  onArchive: () => Promise<unknown>;
}) {
  const { t } = useTranslation('admin');
  const capacity =
    queue.capacity === null ? t('queues.unlimited') : t('queues.upTo', { count: queue.capacity });
  const details = [
    t('queues.prefixShown', { example: `${queue.ticketPrefix}001` }),
    capacity,
    t('queues.servers', { count: queue.serversOnDuty }),
    queue.showEta ? t('queues.etaOn') : t('queues.etaOff'),
  ].join(' · ');
  const alerts = queue.notifyTriggers.map((x) => t(`queues.alerts.trigger.${x}`)).join(', ');
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3" data-testid="queue">
      <div>
        <h2 className="text-lg font-semibold">{queue.name}</h2>
        <p className="text-sm text-muted">{details}</p>
        <p className="text-sm text-muted" data-testid="queue-alerts">
          {t('queues.alerts.summary', { alerts: alerts || t('queues.alerts.none') })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <LinkButton
          variant="secondary"
          render={(p) => <Link to="/admin/queues/$queueId" params={{ queueId: queue.id }} {...p} />}
        >
          {t('queues.services')}
        </LinkButton>
        <LinkButton variant="secondary" render={(p) => <Link to="/admin/forms" {...p} />}>
          {t('queues.intake')}
        </LinkButton>
        <LinkButton
          variant="secondary"
          render={(p) => (
            <Link to="/admin/queues/$queueId/messages" params={{ queueId: queue.id }} {...p} />
          )}
        >
          {t('queues.messages')}
        </LinkButton>
        {canManage ? (
          <>
            <Button variant="secondary" onClick={onEdit}>
              {t('queues.edit')}
            </Button>
            <ConfirmDestructive
              triggerVariant="secondary"
              triggerLabel={t('queues.archive')}
              title={t('queues.archiveTitle', { name: queue.name })}
              description={t('queues.archiveDescription')}
              confirmLabel={t('queues.archiveConfirm')}
              cancelLabel={t('queues.archiveCancel')}
              onConfirm={onArchive}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}

function QueueForm({
  heading,
  initial,
  others,
  pending,
  onCancel,
  onSave,
}: {
  heading: string;
  initial: QueueSettings;
  /** The other queues' text keywords, for the duplicate check. */
  others: readonly (string | null)[];
  pending: boolean;
  onCancel: () => void;
  onSave: (settings: QueueSettings) => void;
}) {
  const { t } = useTranslation('admin');
  const [q, setQ] = useState(initial);
  const [capacity, setCapacity] = useState(initial.capacity?.toString() ?? '');
  const [reminder, setReminder] = useState(initial.servingReminderMinutes?.toString() ?? '');
  const [moreOpen, setMoreOpen] = useState(initial !== NEW_QUEUE);
  const settings = { ...q, servingReminderMinutes: reminder.trim() ? Number(reminder) : null };
  const problem = policyProblem(settings);
  const prefixInvalid = !PREFIX.test(q.ticketPrefix);
  const keywordProblem = smsKeywordProblem(q.smsKeyword, others);
  const number = (key: 'serversOnDuty' | 'joinRatePerMin' | 'onlineJoinsPerHour') => ({
    type: 'number',
    inputMode: 'numeric' as const,
    required: true,
    value: String(q[key]),
    onChange: (event: { target: { value: string } }) =>
      setQ((s) => ({ ...s, [key]: Number(event.target.value) })),
  });
  const policyNumber = (
    key: 'partySizeMin' | 'partySizeMax' | 'graceMinutes' | 'noShowWarningSeconds',
  ) => ({
    type: 'number',
    inputMode: 'numeric' as const,
    required: true,
    value: String(q[key]),
    onChange: (event: { target: { value: string } }) =>
      setQ((s) => ({ ...s, [key]: Number(event.target.value) })),
  });
  const policy = {
    partyMin: policyNumber('partySizeMin'),
    partyMax: policyNumber('partySizeMax'),
    grace: policyNumber('graceMinutes'),
    warning: policyNumber('noShowWarningSeconds'),
  };
  const fields = {
    name: {
      value: q.name,
      onChange: (event: { target: { value: string } }) =>
        setQ((s) => ({ ...s, name: event.target.value })),
    },
    prefix: {
      value: q.ticketPrefix,
      onChange: (event: { target: { value: string } }) =>
        setQ((s) => ({ ...s, ticketPrefix: event.target.value.toUpperCase() })),
    },
    servers: number('serversOnDuty'),
    rate: number('joinRatePerMin'),
    hourly: number('onlineJoinsPerHour'),
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prefixInvalid || problem || keywordProblem) return;
    onSave({ ...settings, capacity: capacity.trim() ? Number(capacity) : null });
  };

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-lg font-semibold">{heading}</h2>
        <Input label={t('queues.name')} required maxLength={80} pattern=".*\S.*" {...fields.name} />
        <Input
          label={t('queues.prefix')}
          hint={t('queues.prefixHint', {
            prefix: PREFIX.test(q.ticketPrefix) ? q.ticketPrefix : 'A',
          })}
          required
          maxLength={3}
          autoCapitalize="characters"
          error={q.ticketPrefix && prefixInvalid ? t('queues.prefixInvalid') : undefined}
          {...fields.prefix}
        />
        <Input label={t('queues.serversOnDuty')} min={0} max={99} {...fields.servers} />
        <Checkbox
          label={t('queues.showEta')}
          hint={t('queues.showEtaHint')}
          checked={q.showEta}
          onChange={(event) => setQ((s) => ({ ...s, showEta: event.target.checked }))}
        />
        <Disclosure
          title={t('queues.moreOptions')}
          open={moreOpen || Boolean(problem || keywordProblem)}
          onOpenChange={setMoreOpen}
        >
          <Input
            label={t('queues.capacity')}
            hint={t('queues.capacityHint')}
            type="number"
            inputMode="numeric"
            min={1}
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
          />
          <Select
            label={t('queues.assignment')}
            hint={t(`queues.assignmentHint.${q.assignmentStrategy}`)}
            value={q.assignmentStrategy}
            onChange={(event) =>
              setQ((s) => ({ ...s, assignmentStrategy: event.target.value as AssignmentStrategy }))
            }
          >
            {ASSIGNMENT_STRATEGIES.map((a) => (
              <option key={a} value={a}>
                {t(`queues.assignmentOption.${a}`)}
              </option>
            ))}
          </Select>
          <Select
            label={t('queues.restriction')}
            hint={t(`queues.restrictionHint.${q.joinRestriction}`)}
            value={q.joinRestriction}
            onChange={(event) =>
              setQ((s) => ({ ...s, joinRestriction: event.target.value as JoinRestriction }))
            }
          >
            {JOIN_RESTRICTIONS.map((r) => (
              <option key={r} value={r}>
                {t(`queues.restrictionOption.${r}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('queues.joinRate')}
            hint={t('queues.joinRateHint')}
            min={1}
            max={1000}
            {...fields.rate}
          />
          <Input
            label={t('queues.onlineJoinsPerHour')}
            hint={t('queues.onlineJoinsPerHourHint')}
            min={1}
            max={1000}
            {...fields.hourly}
          />
          <Input
            label={t('queues.smsKeyword')}
            hint={t('queues.smsKeywordHint')}
            maxLength={20}
            value={q.smsKeyword ?? ''}
            onChange={(event) =>
              setQ((s) => ({
                ...s,
                smsKeyword: event.target.value.trim() ? event.target.value : null,
              }))
            }
            error={keywordProblem ? t(`queues.smsKeywordProblem.${keywordProblem}`) : undefined}
          />
          <fieldset className="flex flex-col gap-4 rounded-control border border-border p-4">
            <legend className="px-1 font-semibold">{t('queues.policies')}</legend>
            <Checkbox
              label={t('queues.joinLater')}
              hint={t('queues.joinLaterHint')}
              checked={q.joinLaterEnabled}
              onChange={(event) => setQ((s) => ({ ...s, joinLaterEnabled: event.target.checked }))}
            />
            {q.joinLaterEnabled ? (
              <Input
                label={t('queues.joinLaterMaxHours')}
                type="number"
                inputMode="numeric"
                min={1}
                max={12}
                required
                value={String(q.joinLaterMaxHours)}
                onChange={(event) =>
                  setQ((s) => ({ ...s, joinLaterMaxHours: Number(event.target.value) }))
                }
              />
            ) : null}
            <Checkbox
              label={t('queues.partySize')}
              hint={t('queues.partySizeHint')}
              checked={q.partySizeEnabled}
              onChange={(event) => setQ((s) => ({ ...s, partySizeEnabled: event.target.checked }))}
            />
            {q.partySizeEnabled ? (
              <div className="flex gap-3">
                <Input label={t('queues.partySizeMin')} {...policy.partyMin} min={1} max={50} />
                <Input label={t('queues.partySizeMax')} {...policy.partyMax} min={1} max={50} />
              </div>
            ) : null}
            <Checkbox
              label={t('queues.autoNoShow')}
              hint={t('queues.autoNoShowHint')}
              checked={q.autoNoShowEnabled}
              onChange={(event) => setQ((s) => ({ ...s, autoNoShowEnabled: event.target.checked }))}
            />
            {q.autoNoShowEnabled ? (
              <div className="flex gap-3">
                <Input label={t('queues.graceMinutes')} {...policy.grace} min={1} max={120} />
                <Input
                  label={t('queues.warningSeconds')}
                  hint={t('queues.warningSecondsHint')}
                  {...policy.warning}
                  min={20}
                />
              </div>
            ) : null}
            <Input
              label={t('queues.servingReminder')}
              hint={t('queues.servingReminderHint')}
              type="number"
              inputMode="numeric"
              min={15}
              value={reminder}
              onChange={(event) => setReminder(event.target.value)}
            />
            <p role="alert" className="font-medium text-danger-strong empty:hidden">
              {problem ? t(`queues.policyProblem.${problem}`) : null}
            </p>
          </fieldset>
          <GuestAlerts
            triggers={q.notifyTriggers}
            threshold={q.almostUpThreshold}
            onTriggers={(notifyTriggers) => setQ((s) => ({ ...s, notifyTriggers }))}
            onThreshold={(almostUpThreshold) => setQ((s) => ({ ...s, almostUpThreshold }))}
          />
        </Disclosure>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {t('queues.cancel')}
          </Button>
          <Button type="submit" loading={pending} loadingLabel={t('queues.saving')}>
            {t('queues.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
