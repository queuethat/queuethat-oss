import { Badge, Button, Checkbox, EmptyState, Input, PageHeader, Select, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentOrg } from '../../../auth/current.ts';
import { canManageWebhooks, useSendTest } from '../webhooks/api.ts';
import {
  CHAT_ALERTS,
  CHAT_KINDS,
  chatEndpointsQuery,
  useConnectChat,
  type ChatAlertKey,
  type ChatKind,
} from './api.ts';

const KNOWN_ERRORS = ['invalid_url', 'invalid_input', 'permission_denied', 'not_found'];

/** Staff chat alerts (I-4, #316): pick the app, paste its incoming-webhook URL, choose the alerts. */
export function ChatAlertsPage() {
  const { t } = useTranslation('admin-chat-alerts');
  const org = useCurrentOrg();
  if (!org) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <div className="flex flex-col gap-6 pb-8">
      <PageHeader title={t('title')} />
      {canManageWebhooks(org.role) ? (
        <>
          <ConnectForm orgId={org.id} />
          <Connected orgId={org.id} />
        </>
      ) : (
        <p className="text-muted">{t('adminsOnly')}</p>
      )}
    </div>
  );
}

function ConnectForm({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-chat-alerts');
  const connect = useConnectChat(orgId);
  const [kind, setKind] = useState<ChatKind>('slack');
  const [url, setUrl] = useState('');
  const [alerts, setAlerts] = useState<ChatAlertKey[]>(['joined']);
  const [waiting, setWaiting] = useState(10);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate(
      { url, kind, alerts, waiting },
      {
        onSuccess: () => {
          setUrl('');
          setAlerts(['joined']);
        },
      },
    );
  };
  const failure = connect.error
    ? (`errors.${KNOWN_ERRORS.includes(connect.error.message) ? connect.error.message : 'unknown'}` as 'errors.unknown')
    : null;
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-labelledby="connect-heading">
      <h2 id="connect-heading" className="text-xl font-semibold">
        {t('connect.title')}
      </h2>
      <Select
        label={t('connect.app')}
        value={kind}
        onChange={(e) => setKind(e.target.value as ChatKind)}
      >
        {CHAT_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`kind.${k}`)}
          </option>
        ))}
      </Select>
      <p className="text-muted">{t(`howTo.${kind}`)}</p>
      <Input
        label={t('connect.url')}
        hint={t(`urlHint.${kind}`)}
        type="url"
        required
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">{t('connect.alerts')}</legend>
        {CHAT_ALERTS.map((a) => (
          <Checkbox
            key={a.key}
            label={t(`alert.${a.key}`)}
            checked={alerts.includes(a.key)}
            onChange={(event) =>
              setAlerts((now) =>
                event.target.checked ? [...now, a.key] : now.filter((x) => x !== a.key),
              )
            }
          />
        ))}
      </fieldset>
      {alerts.includes('queueLong') ? (
        <Input
          label={t('connect.threshold')}
          hint={t('connect.thresholdHint')}
          type="number"
          min={1}
          max={99999}
          required
          value={String(waiting)}
          onChange={(event) => setWaiting(Number(event.target.value))}
        />
      ) : null}
      {failure ? <p role="alert">{t(failure, { host: t(`host.${kind}`) })}</p> : null}
      {connect.isSuccess ? <p role="status">{t('connect.saved')}</p> : null}
      <div>
        <Button
          type="submit"
          disabled={alerts.length === 0}
          loading={connect.isPending}
          loadingLabel={t('connect.saving')}
        >
          {t('connect.save')}
        </Button>
      </div>
    </form>
  );
}

function Connected({ orgId }: { orgId: string }) {
  const { t } = useTranslation('admin-chat-alerts');
  const query = useQuery(chatEndpointsQuery(orgId));
  if (query.isError) return <p role="alert">{t('errors.unknown')}</p>;
  if (!query.data) return <Skeleton label={t('loading')} rows={2} />;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="connected-heading">
      <h2 id="connected-heading" className="text-xl font-semibold">
        {t('connected.title')}
      </h2>
      {query.data.length === 0 ? (
        <EmptyState title={t('connected.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((endpoint) => (
            <ChatRow key={endpoint.id} endpoint={endpoint} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatRow({
  endpoint,
}: {
  endpoint: {
    id: string;
    kind: string;
    active: boolean;
    event_types: string[];
    alert_thresholds: unknown;
  };
}) {
  const { t } = useTranslation('admin-chat-alerts');
  const test = useSendTest(endpoint.id);
  const waiting = (endpoint.alert_thresholds as { waiting?: number } | null)?.waiting;
  const chosen = CHAT_ALERTS.filter((a) => endpoint.event_types.includes(a.event));
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="chat-alert">
      <div className="flex flex-col gap-1">
        <p className="font-semibold">
          {t(`kind.${endpoint.kind as ChatKind}`)}{' '}
          {endpoint.active ? null : <Badge tone="danger">{t('connected.off')}</Badge>}
        </p>
        <p className="text-muted">
          {chosen
            .map((a) =>
              a.key === 'queueLong' && waiting
                ? t('connected.queueLongAt', { count: waiting })
                : t(`alert.${a.key}`),
            )
            .join(', ')}
        </p>
        {test.isSuccess ? <p role="status">{t('connected.testSent')}</p> : null}
        {test.isError ? <p role="alert">{t('errors.unknown')}</p> : null}
      </div>
      <Button
        variant="secondary"
        disabled={!endpoint.active}
        loading={test.isPending}
        loadingLabel={t('connected.testing')}
        onClick={() => test.mutate()}
      >
        {t('connected.test')}
      </Button>
    </li>
  );
}
