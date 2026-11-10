import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import {
  visitSearchQuery,
  visitTimelineQuery,
  type TimelineGrant,
  type VisitSearch,
  type VisitTimeline,
} from './api.ts';
import { formatInZone, formatWhen } from './format.ts';

const STATUSES = [
  'expected',
  'waiting',
  'called',
  'serving',
  'served',
  'no_show',
  'cancelled',
  'removed',
  'expired',
] as const;
const ACTORS = ['guest', 'staff', 'system', 'device', 'platform'] as const;
const EMPTY: VisitSearch = { ticket: '', day: '', status: '' };

/** Why a lookup failed, as the page words it. A missing grant is the expected case. */
function failure(error: Error | null): 'noAccess' | 'notFound' | 'failed' | null {
  if (!error) return null;
  if (error.message === 'permission_denied') return 'noAccess';
  if (error.message === 'not_found') return 'notFound';
  return 'failed';
}

function GrantBanner({ grant }: { grant: TimelineGrant }) {
  const { t, i18n } = useTranslation('platform');
  return (
    <div
      role="status"
      data-testid="grant-banner"
      className="rounded-control border border-border p-3"
    >
      <p className="font-semibold">
        {t('visits.grant.label')}
        {grant.break_glass ? <Badge tone="warning">{t('visits.grant.breakGlass')}</Badge> : null}
      </p>
      <p>
        {t('visits.grant.summary', {
          scope: t(`org.scope.${grant.scope}`),
          until: formatWhen(grant.expires_at, i18n.language, ''),
          reason: grant.reason,
        })}
      </p>
      <p className="text-muted">{t('visits.grant.readOnly')}</p>
    </div>
  );
}

function NoAccess({ orgId }: { orgId: string }) {
  const { t } = useTranslation('platform');
  return (
    <EmptyState
      title={t('visits.noAccess.title')}
      description={t('visits.noAccess.body')}
      secondary={
        <Link to="/platform/orgs/$orgId" params={{ orgId }} className="underline">
          {t('visits.noAccess.operator')}
        </Link>
      }
    />
  );
}

function Timeline({ timeline }: { timeline: VisitTimeline }) {
  const { t, i18n } = useTranslation('platform');
  const at = (when: string) => formatInZone(when, i18n.language, timeline.tz);
  return (
    <Card className="flex flex-col gap-4" data-testid="timeline">
      <GrantBanner grant={timeline.support_grant} />
      <h2 className="text-xl font-semibold">
        {t('visits.timeline.title', { ticket: timeline.display_ticket })}
      </h2>
      <p>
        {t('visits.timeline.summary', {
          queue: timeline.queue_name,
          location: timeline.location_name,
          day: timeline.service_day,
          tz: timeline.tz,
        })}
      </p>
      <p>
        {t('visits.timeline.facts', {
          status: t(`visits.statuses.${timeline.status}`, { defaultValue: timeline.status }),
          party: timeline.party_size,
          calls: timeline.call_count,
          source: timeline.source,
        })}
      </p>

      <h3 className="text-lg font-semibold">{t('visits.timeline.events')}</h3>
      {timeline.events.length === 0 ? (
        <p>{t('visits.timeline.noEvents')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {timeline.events.map((e) => (
            <li key={e.id} data-testid="event" className="flex flex-wrap gap-x-4">
              <time dateTime={e.occurred_at} className="text-muted">
                {at(e.occurred_at)}
              </time>
              <span className="font-semibold">
                {e.type}
                {e.undone ? ` (${t('visits.timeline.undone')})` : ''}
              </span>
              <span>{e.from_status ? `${e.from_status} → ${e.to_status}` : e.to_status}</span>
              <span>
                {ACTORS.includes(e.actor_kind) ? t(`visits.actor.${e.actor_kind}`) : e.actor_kind}
                {e.via_support ? ` · ${t('visits.timeline.viaSupport')}` : ''}
              </span>
              {e.undoes_type ? (
                <span className="text-muted">
                  {t('visits.timeline.undoes', { type: e.undoes_type })}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <h3 className="text-lg font-semibold">{t('visits.timeline.notifications')}</h3>
      {timeline.notifications.length === 0 ? (
        <p>{t('visits.timeline.noNotifications')}</p>
      ) : (
        <table className="w-full text-left">
          <thead className="text-sm text-muted">
            <tr>
              <th className="py-2 pr-4">{t('visits.timeline.when')}</th>
              <th className="py-2 pr-4">{t('visits.timeline.channel')}</th>
              <th className="py-2 pr-4">{t('visits.timeline.template')}</th>
              <th className="py-2 pr-4">{t('visits.timeline.recipient')}</th>
              <th className="py-2">{t('visits.timeline.result')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {timeline.notifications.map((n) => (
              <tr key={n.id} data-testid="notification">
                <td className="py-2 pr-4">{at(n.created_at)}</td>
                {/* eslint-disable-next-line no-restricted-properties -- a database column, not a Realtime channel */}
                <td className="py-2 pr-4">{n.channel}</td>
                <td className="py-2 pr-4">{n.template_key}</td>
                <td className="py-2 pr-4 break-all">{n.recipient}</td>
                <td className="py-2">
                  {n.status}
                  {n.error_code ? ` (${n.error_code})` : ''},{' '}
                  {t('visits.timeline.attempts', { count: n.attempts })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * Support's visit lookup (#1136) for one tenant: search by ticket, service day and status, then
 * open one visit's timeline. Nothing loads until the form is submitted, because every lookup is
 * audited; without a live support grant the database refuses and the page explains how to get one.
 */
export function VisitLookup({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation('platform');
  const [draft, setDraft] = useState<VisitSearch>(EMPTY);
  const [submitted, setSubmitted] = useState<VisitSearch | null>(null);
  const [run, setRun] = useState(0);
  const [visitId, setVisitId] = useState<string | null>(null);
  const search = useQuery({
    ...visitSearchQuery(orgId, submitted ?? EMPTY, run),
    enabled: !!submitted,
  });
  const timeline = useQuery({
    ...visitTimelineQuery(orgId, visitId ?? ''),
    enabled: !!visitId,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setVisitId(null);
    // Each submit is its own run, so searching again re-runs (and re-audits) the same filters once.
    setSubmitted({ ...draft });
    setRun((n) => n + 1);
  };
  const denied = failure(search.error) ?? failure(timeline.error);

  return (
    <div className="flex flex-col gap-6">
      <Link to="/platform/orgs/$orgId" params={{ orgId }} className="underline">
        {t('visits.back')}
      </Link>
      <h1 className="text-2xl font-semibold">{t('visits.title')}</h1>
      <p>{t('visits.intro')}</p>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
        <Input
          label={t('visits.ticket')}
          hint={t('visits.ticketHint')}
          value={draft.ticket}
          maxLength={20}
          onChange={(e) => setDraft({ ...draft, ticket: e.target.value })}
        />
        <Input
          label={t('visits.day')}
          type="date"
          value={draft.day}
          onChange={(e) => setDraft({ ...draft, day: e.target.value })}
        />
        <Select
          label={t('visits.status')}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as VisitSearch['status'] })}
        >
          <option value="">{t('visits.anyStatus')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`visits.statuses.${s}`)}
            </option>
          ))}
        </Select>
        <Button type="submit" loading={search.isFetching} loadingLabel={t('visits.searching')}>
          {t('visits.search')}
        </Button>
      </form>

      {denied === 'noAccess' ? <NoAccess orgId={orgId} /> : null}
      {denied === 'notFound' ? <p role="alert">{t('visits.notFound')}</p> : null}
      {denied === 'failed' ? <p role="alert">{t('visits.failed')}</p> : null}

      {search.data && !search.error ? (
        search.data.length === 0 ? (
          <EmptyState title={t('visits.noResults')} />
        ) : (
          <Card className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">{t('visits.results')}</h2>
            <table className="w-full text-left">
              <thead className="text-sm text-muted">
                <tr>
                  <th className="py-2 pr-4">{t('visits.columns.ticket')}</th>
                  <th className="py-2 pr-4">{t('visits.columns.queue')}</th>
                  <th className="py-2 pr-4">{t('visits.columns.day')}</th>
                  <th className="py-2 pr-4">{t('visits.columns.status')}</th>
                  <th className="py-2 pr-4">{t('visits.columns.joined')}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {search.data.map((hit) => (
                  <tr key={hit.visit_id} data-testid="hit">
                    <td className="py-2 pr-4 font-semibold">{hit.display_ticket}</td>
                    <td className="py-2 pr-4">{`${hit.queue_name} · ${hit.location_name}`}</td>
                    <td className="py-2 pr-4">{hit.service_day}</td>
                    <td className="py-2 pr-4">{t(`visits.statuses.${hit.status}`)}</td>
                    <td className="py-2 pr-4">{formatWhen(hit.joined_at, i18n.language, '')}</td>
                    <td className="py-2">
                      <Button variant="secondary" onClick={() => setVisitId(hit.visit_id)}>
                        {t('visits.open')}
                        <span className="sr-only">{` ${hit.display_ticket}`}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )
      ) : null}

      {visitId && timeline.isFetching ? <Spinner label={t('visits.searching')} /> : null}
      {timeline.data && !timeline.error ? <Timeline timeline={timeline.data} /> : null}
    </div>
  );
}
