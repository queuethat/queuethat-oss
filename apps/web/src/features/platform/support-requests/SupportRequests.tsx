import { Badge, Button, Card, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { formatWhen } from '../format.ts';
import { supportRequestsQuery, useSetSupportRequestStatus, type SupportRequest } from './api.ts';

/** The tenant page's "Support requests": what staff sent from the app, with the context beside it. */
export function SupportRequests({ orgId }: { orgId: string }) {
  const { t } = useTranslation('platform');
  const requests = useQuery(supportRequestsQuery(orgId));
  const set = useSetSupportRequestStatus(orgId);
  return (
    <Card className="flex flex-col gap-3" data-testid="support-requests">
      <h2 className="text-xl font-semibold">{t('supportRequests.title')}</h2>
      {requests.isPending ? <Spinner label={t('supportRequests.loading')} /> : null}
      {requests.isError ? <p role="alert">{t('supportRequests.failed')}</p> : null}
      {requests.data?.length === 0 ? <p>{t('supportRequests.none')}</p> : null}
      {set.isError ? <p role="alert">{t('supportRequests.actionFailed')}</p> : null}
      <ul className="flex flex-col gap-4">
        {requests.data?.map((r) => (
          <Row
            key={r.id}
            request={r}
            busy={set.isPending && set.variables?.id === r.id}
            onChange={(status) => set.mutate({ id: r.id, status })}
          />
        ))}
      </ul>
    </Card>
  );
}

function Row({
  request: r,
  busy,
  onChange,
}: {
  request: SupportRequest;
  busy: boolean;
  onChange: (status: 'open' | 'closed') => void;
}) {
  const { t, i18n } = useTranslation('platform');
  const c = r.context;
  const facts: [string, string | undefined][] = [
    [
      t('supportRequests.from'),
      r.user_email ? `${r.user_email}${c.role ? ` (${c.role})` : ''}` : undefined,
    ],
    [t('supportRequests.page'), c.route],
    [t('supportRequests.plan'), c.plan],
    [t('supportRequests.version'), c.app_version],
    [t('supportRequests.browser'), c.browser],
    [t('supportRequests.viewport'), c.viewport ? `${c.viewport.w} × ${c.viewport.h}` : undefined],
    [
      t('supportRequests.online'),
      c.online === undefined
        ? undefined
        : t(c.online ? 'supportRequests.yes' : 'supportRequests.no'),
    ],
    [t('supportRequests.lastError'), c.last_error_id],
  ];
  return (
    <li
      className="flex flex-col gap-2 border-t border-border pt-3"
      data-testid={`support-request-${r.reference}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono">{r.reference}</span>
        <Badge tone={r.status === 'open' ? 'warning' : 'neutral'}>
          {t(`supportRequests.status.${r.status}`)}
        </Badge>
        <span className="text-muted">{formatWhen(r.created_at, i18n.language, '')}</span>
        <Button
          variant="secondary"
          className="ml-auto"
          loading={busy}
          loadingLabel={t('supportRequests.working')}
          onClick={() => onChange(r.status === 'open' ? 'closed' : 'open')}
        >
          {r.status === 'open' ? t('supportRequests.close') : t('supportRequests.reopen')}
        </Button>
      </div>
      <h3 className="font-semibold">{r.subject}</h3>
      {/* Staff-written text: rendered as text, wrapped, never as HTML. */}
      <p className="whitespace-pre-wrap break-words">{r.message}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
      </dl>
    </li>
  );
}
