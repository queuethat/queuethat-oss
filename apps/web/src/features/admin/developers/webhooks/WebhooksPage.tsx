import {
  Badge,
  Button,
  Checkbox,
  ConfirmDestructive,
  Dialog,
  Input,
  PageHeader,
  ScrollRegion,
  Select,
  Skeleton,
} from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { ScreenEmpty } from '../../../../components/ScreenEmpty.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_KINDS,
  canManageWebhooks,
  deliveriesQuery,
  endpointStatus,
  endpointsQuery,
  useCreateEndpoint,
  useRedeliver,
  useRotateSecret,
  useSendTest,
  useSetActive,
  type WebhookEvent,
  type WebhookKind,
} from './api.ts';

const KNOWN_ERRORS = ['invalid_url', 'invalid_input', 'permission_denied', 'not_found'];
type Underscored<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${B}` : S;
/** The locale key for an event: i18next reads a dot as a path separator. */
const eventKey = (event: WebhookEvent) =>
  `event.${event.replace('.', '_') as Underscored<WebhookEvent>}` as const;
const TONE = { active: 'success', failing: 'warning', disabled: 'danger' } as const;

/** Webhook endpoints (I-2, #313): add, rotate the secret, read the delivery log, redeliver. */
export function WebhooksPage() {
  const { t } = useTranslation('admin-webhooks');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      {canManageWebhooks(org.role) ? (
        <EndpointList orgId={org.id} />
      ) : (
        <p className="text-muted">{t('adminsOnly')}</p>
      )}
    </div>
  );
}

function EndpointList({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-webhooks');
  const query = useQuery(endpointsQuery(orgId));
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rotate = useRotateSecret();
  const setActive = useSetActive(orgId);

  if (query.isError) return <p role="alert">{t('errors.unknown')}</p>;
  if (!query.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="endpoints-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="endpoints-heading" className="text-xl font-semibold">
          {t('list.title')}
        </h2>
        <Button onClick={() => setCreating(true)}>{t('create.open')}</Button>
      </div>
      <p className="text-muted">{t('list.intro')}</p>
      {query.data.length === 0 ? (
        <ScreenEmpty kind="developers" />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((endpoint) => {
            const status = endpointStatus(endpoint);
            return (
              <li key={endpoint.id} className="flex flex-col gap-3 py-3" data-testid="webhook">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="break-all font-semibold">
                      {endpoint.url} <Badge tone={TONE[status]}>{t(`status.${status}`)}</Badge>
                    </p>
                    <p className="text-muted">
                      {t(`kind.${endpoint.kind as WebhookKind}`)}
                      {' · '}
                      {endpoint.event_types.map((e) => t(eventKey(e as WebhookEvent))).join(', ')}
                    </p>
                    {endpoint.include_guest_name ? (
                      <p className="text-muted">{t('list.guestName')}</p>
                    ) : null}
                    {endpoint.disabled_reason ? (
                      <p className="text-danger-strong">{endpoint.disabled_reason}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      aria-expanded={open === endpoint.id}
                      onClick={() => setOpen(open === endpoint.id ? null : endpoint.id)}
                    >
                      {t('log.toggle')}
                    </Button>
                    {endpoint.active ? null : (
                      <Button
                        loading={setActive.isPending}
                        loadingLabel={t('enable.enabling')}
                        onClick={() => setActive.mutate({ endpointId: endpoint.id, active: true })}
                      >
                        {t('enable.trigger')}
                      </Button>
                    )}
                    <ConfirmDestructive
                      triggerLabel={t('rotate.trigger')}
                      triggerAriaLabel={t('rotate.triggerFor', { url: endpoint.url })}
                      title={t('rotate.title')}
                      description={t('rotate.description')}
                      confirmLabel={t('rotate.confirm')}
                      cancelLabel={t('rotate.cancel')}
                      triggerVariant="secondary"
                      onConfirm={() => rotate.mutateAsync(endpoint.id)}
                    />
                  </div>
                </div>
                {open === endpoint.id ? <DeliveryLog endpointId={endpoint.id} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      <CreateDialog orgId={orgId} open={creating} onClose={() => setCreating(false)} />
      <Dialog
        open={!!rotate.data}
        onClose={() => undefined}
        title={t('shown.rotatedTitle')}
        description={t('shown.rotatedDescription')}
      >
        {rotate.data ? <ShownSecret secret={rotate.data.secret} onDone={rotate.reset} /> : null}
      </Dialog>
    </section>
  );
}

function DeliveryLog({ endpointId }: { endpointId: string }) {
  const { t, i18n } = useTranslation('admin-webhooks');
  const query = useQuery(deliveriesQuery(endpointId));
  const redeliver = useRedeliver(endpointId);
  const test = useSendTest(endpointId);
  const [payload, setPayload] = useState<string | null>(null);
  if (!query.data) return <Skeleton label={t('log.loading')} rows={2} />;
  const ping = (
    <div>
      <Button
        variant="secondary"
        loading={test.isPending}
        loadingLabel={t('log.testing')}
        onClick={() => test.mutate()}
      >
        {t('log.test')}
      </Button>
    </div>
  );
  if (query.data.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted">{t('log.empty')}</p>
        {ping}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {ping}
      <ul className="flex flex-col divide-y divide-border" aria-label={t('log.title')}>
        {query.data.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
            data-testid="delivery"
          >
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{d.event_type}</span>
              <Badge
                tone={
                  d.status === 'delivered'
                    ? 'success'
                    : d.status === 'queued' || d.status === 'claimed'
                      ? 'info'
                      : 'danger'
                }
              >
                {t(`log.status.${d.status as 'queued'}`)}
              </Badge>
              <span className="text-muted">
                {t('log.attempts', { count: d.attempts })}
                {d.response_status ? ` · ${t('log.response', { code: d.response_status })}` : ''}
                {' · '}
                {new Date(d.created_at).toLocaleString(i18n.language)}
              </span>
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPayload(JSON.stringify(d.payload, null, 2))}
              >
                {t('log.payload')}
              </Button>
              {d.status === 'queued' || d.status === 'claimed' ? null : (
                <Button
                  variant="secondary"
                  loading={redeliver.isPending && redeliver.variables === d.id}
                  loadingLabel={t('log.redelivering')}
                  onClick={() => redeliver.mutate(d.id)}
                >
                  {t('log.redeliver')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={payload !== null} onClose={() => setPayload(null)} title={t('log.payload')}>
        <ScrollRegion label={t('log.payload')} className="max-h-80 overflow-y-auto">
          <pre className="rounded-control bg-secondary p-3 text-sm">{payload}</pre>
        </ScrollRegion>
        <div className="flex justify-end">
          <Button onClick={() => setPayload(null)}>{t('log.close')}</Button>
        </div>
      </Dialog>
    </div>
  );
}

function CreateDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin-webhooks');
  const create = useCreateEndpoint(orgId);
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<WebhookKind>('generic');
  const [events, setEvents] = useState<WebhookEvent[]>(['visit.joined']);
  const [guestName, setGuestName] = useState(false);

  const close = () => {
    create.reset();
    setUrl('');
    setKind('generic');
    setEvents(['visit.joined']);
    setGuestName(false);
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      url,
      kind,
      eventTypes: WEBHOOK_EVENTS.filter((e) => events.includes(e)),
      includeGuestName: guestName,
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
        <ShownSecret secret={create.data.secret} onDone={close} />
      </Dialog>
    );
  }
  const failure = create.error
    ? (`errors.${KNOWN_ERRORS.includes(create.error.message) ? create.error.message : 'unknown'}` as 'errors.unknown')
    : null;
  return (
    <Dialog open={open} onClose={close} title={t('create.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label={t('create.url')}
          hint={t('create.urlHint')}
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Select
          label={t('create.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as WebhookKind)}
        >
          {WEBHOOK_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </Select>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('create.events')}</legend>
          {WEBHOOK_EVENTS.map((e) => (
            <Checkbox
              key={e}
              label={t(eventKey(e))}
              checked={events.includes(e)}
              onChange={(event) =>
                setEvents((now) =>
                  event.target.checked ? [...now, e] : now.filter((x) => x !== e),
                )
              }
            />
          ))}
        </fieldset>
        <Checkbox
          label={t('create.guestName')}
          hint={t('create.guestNameWarning')}
          checked={guestName}
          onChange={(event) => setGuestName(event.target.checked)}
        />
        <p role="alert" className="font-medium text-danger-strong empty:hidden">
          {failure ? t(failure) : null}
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={close}>
            {t('create.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={events.length === 0}
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

function ShownSecret({ secret, onDone }: { secret: string; onDone: () => void }) {
  const { t } = useTranslation('admin-webhooks');
  const [copied, setCopied] = useState(false);
  const [stored, setStored] = useState(false);
  const copy = async () => {
    // The clipboard needs a secure context; the field stays selectable either way.
    await navigator.clipboard?.writeText(secret).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="shown-secret">
      <Input
        label={t('shown.label')}
        readOnly
        value={secret}
        className="font-mono"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button variant="secondary" onClick={() => void copy()}>
        {copied ? t('shown.copied') : t('shown.copy')}
      </Button>
      <Checkbox
        label={t('shown.stored')}
        checked={stored}
        onChange={(e) => setStored(e.target.checked)}
      />
      <div className="flex justify-end">
        <Button disabled={!stored} onClick={onDone}>
          {t('shown.done')}
        </Button>
      </div>
    </div>
  );
}
