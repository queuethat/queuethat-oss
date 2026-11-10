import { Badge, Card, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { TenantActions, TenantActionsReadOnly } from './actions/TenantActions.tsx';
import { BillingPanel } from './billing/BillingPanel.tsx';
import { EntitlementOverrides } from './ops/EntitlementOverrides.tsx';
import { ActivationSection } from './Activation.tsx';
import { activationQuery, orgQuery } from './api.ts';
import { SmsPause } from './ops/SmsPause.tsx';
import { SupportRequests } from './support-requests/SupportRequests.tsx';
import { NotesSection } from './notes/NotesSection.tsx';
import { DeliveryLog } from './deliveries/DeliveryLog.tsx';
import { formatWhen, STATUS_TONE } from './format.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

/** One tenant: summary, members, locations and queues, screens, recent audit, support access. */
export function OrgDetail({ orgId, canAct }: { orgId: string; canAct: boolean }) {
  const { t, i18n } = useTranslation('platform');
  const detail = useQuery(orgQuery(orgId));
  const activation = useQuery(activationQuery([orgId])).data?.get(orgId);
  const when = (at: string | null, fallback = '') => formatWhen(at, i18n.language, fallback);

  if (!detail.data) return <Spinner label={t('org.loading')} />;
  const {
    org,
    members,
    locations,
    devices,
    recent_audit: audit,
    support_grant: grant,
  } = detail.data;
  const emailOf = new Map(members.map((m) => [m.user_id, m.email]));
  return (
    <div className="flex flex-col gap-6">
      <Link to="/platform" className="underline">
        {t('org.back')}
      </Link>
      <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
        {org.name}
        <Badge tone={STATUS_TONE[org.status]}>{t(`status.${org.status}`)}</Badge>
      </h1>

      <Section title={t('org.summary')}>
        {org.status === 'suspended' ? (
          <p role="status">
            {t('org.suspended', {
              at: when(detail.data.suspended_at),
              reason: detail.data.suspended_reason ?? '',
            })}
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted">{t('org.slug')}</dt>
          <dd>{org.slug ? `/q/${org.slug}` : ''}</dd>
          <dt className="text-muted">{t('org.owner')}</dt>
          <dd className="break-all">{org.owner_email}</dd>
          <dt className="text-muted">{t('org.created')}</dt>
          <dd>{when(org.created_at)}</dd>
          <dt className="text-muted">{t('org.lastActivity')}</dt>
          <dd>{when(org.last_activity_at, t('directory.never'))}</dd>
          <dt className="text-muted">{t('org.visits')}</dt>
          <dd>{org.visits_7d}</dd>
          <dt className="text-muted">{t('org.notifications')}</dt>
          <dd>
            {t('org.notificationCounts', {
              sent: org.notifications_sent_7d,
              failed: org.notifications_failed_7d,
            })}
          </dd>
        </dl>
      </Section>

      {activation ? <ActivationSection activation={activation} /> : null}

      {canAct ? (
        <TenantActions key={org.id} org={org} members={members} />
      ) : (
        <TenantActionsReadOnly />
      )}

      <NotesSection orgId={orgId} />

      <BillingPanel orgId={orgId} />

      <EntitlementOverrides orgId={orgId} />

      <SmsPause orgId={orgId} canAct={canAct} />

      <SupportRequests orgId={orgId} />

      <Section title={t('org.support')}>
        {grant ? (
          <p data-testid="support-grant">
            {grant.break_glass ? `${t('org.breakGlass')} · ` : null}
            {t('org.grant', {
              scope: t(`org.scope.${grant.scope}`),
              until: when(grant.expires_at),
              reason: grant.reason,
            })}
          </p>
        ) : (
          <p>{t('org.noSupport')}</p>
        )}
        <Link
          to="/platform/$"
          params={{ _splat: 'visits' }}
          search={{ org: orgId }}
          className="underline"
        >
          {t('org.visitLookup')}
        </Link>
      </Section>

      <Section title={t('org.members')}>
        <table className="w-full text-left">
          <thead className="text-sm text-muted">
            <tr>
              <th className="py-2 pr-4">{t('org.email')}</th>
              <th className="py-2 pr-4">{t('org.role')}</th>
              <th className="py-2">{t('org.joined')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => (
              <tr key={m.user_id}>
                <td className="py-2 pr-4 break-all">{m.email}</td>
                <td className="py-2 pr-4">{m.role}</td>
                <td className="py-2">{when(m.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={t('org.locations')}>
        <ul className="flex flex-col gap-3">
          {locations.map((location) => (
            <li key={location.id}>
              <p className="font-semibold">
                {location.name}{' '}
                <span className="font-normal text-muted">{`/q/${location.slug}`}</span>
              </p>
              <p className="text-muted">
                {location.queues.length === 0
                  ? t('org.noQueues')
                  : location.queues
                      .map((q) => (q.archived ? `${q.name} (${t('org.archived')})` : q.name))
                      .join(', ')}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('org.devices')}>
        {devices.length === 0 ? (
          <p>{t('org.noDevices')}</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="py-2 pr-4">{t('org.devices')}</th>
                <th className="py-2 pr-4">{t('org.lastSeen')}</th>
                <th className="py-2 pr-4">{t('org.version')}</th>
                <th className="py-2">{t('org.revoked')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="py-2 pr-4">{t('org.device', { name: d.name, kind: d.kind })}</td>
                  <td className="py-2 pr-4">{when(d.last_seen_at, t('org.neverSeen'))}</td>
                  <td className="py-2 pr-4">{d.app_version ?? ''}</td>
                  <td className="py-2">{when(d.revoked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={t('org.messages')}>
        <DeliveryLog orgId={org.id} />
      </Section>

      <Section title={t('org.audit')}>
        {audit.length === 0 ? (
          <p>{t('org.noAudit')}</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="py-2 pr-4">{t('org.when')}</th>
                <th className="py-2 pr-4">{t('org.actor')}</th>
                <th className="py-2">{t('org.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 pr-4">{when(a.at)}</td>
                  <td className="py-2 pr-4 break-all">
                    {(a.actor && emailOf.get(a.actor)) ?? a.role ?? ''}
                  </td>
                  <td className="py-2">
                    {a.action} {a.table_name}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Link
          to="/platform/$"
          params={{ _splat: 'audit' }}
          search={{ org: org.id }}
          className="underline"
        >
          {t('org.viewAudit')}
        </Link>
      </Section>
    </div>
  );
}
