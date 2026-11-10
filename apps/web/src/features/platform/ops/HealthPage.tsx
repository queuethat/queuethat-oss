import { Badge, Card, EmptyState, PageHeader, Spinner } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { appConfig } from '../../../lib/config.ts';
import { platformHealthQuery } from './api.ts';
import { cronHealth, healthOf, type Health } from './summaries.ts';

const tileTone: Record<Health, string> = {
  ok: '',
  warning: 'bg-warning-soft text-warning-strong',
};

function Tile({ label, value, health }: { label: string; value: string; health: Health }) {
  const { t } = useTranslation('platform');
  return (
    <Card className={tileTone[health]} data-health={health}>
      <p className="text-sm font-medium">{label}</p>
      <p className="text-3xl font-bold">{value}</p>
      {health === 'warning' ? (
        <p className="font-semibold">{t('ops.health.needsAttention')}</p>
      ) : null}
    </Card>
  );
}

/**
 * `/platform/health` (PLT13, #419): notification backlog, dead letters and pg_cron runs, from
 * `api.platform_health`. Counts only; no tenant rows.
 */
export function HealthPage({ sentryUrl = appConfig().sentryIssuesUrl }: { sentryUrl?: string }) {
  const { t, i18n } = useTranslation('platform');
  const health = useQuery(platformHealthQuery);
  if (!health.data) {
    return health.isError ? (
      <EmptyState title={t('ops.loadFailed')} />
    ) : (
      <Spinner label={t('ops.loading')} />
    );
  }
  const h = health.data;
  const tones = healthOf(h);
  const number = new Intl.NumberFormat(i18n.language);
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const minutes = Math.ceil((h.oldest_queued_seconds ?? 0) / 60);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('ops.health.title')}
        actions={
          sentryUrl ? (
            <a
              className="inline-flex min-h-target items-center font-medium text-primary underline"
              href={sentryUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('ops.health.sentry')}
            </a>
          ) : null
        }
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4">
        <Tile
          label={t('ops.health.queued')}
          value={number.format(h.notifications_queued ?? 0)}
          health={tones.queued}
        />
        <Tile
          label={t('ops.health.oldestQueued')}
          value={
            h.oldest_queued_seconds == null
              ? t('ops.health.none')
              : t('ops.health.minutes', { count: minutes })
          }
          health={tones.queued}
        />
        <Tile
          label={t('ops.health.dead')}
          value={number.format(h.notifications_dead ?? 0)}
          health={tones.dead}
        />
        <Tile
          label={t('ops.health.activeOrgs')}
          value={number.format(h.orgs_active_today ?? 0)}
          health="ok"
        />
      </div>
      <section aria-labelledby="cron-jobs" className="flex flex-col gap-2">
        <h2 id="cron-jobs" className="text-xl font-semibold">
          {t('ops.health.cron')}
        </h2>
        <table className="w-full text-left">
          <thead>
            <tr>
              <th scope="col">{t('ops.health.job')}</th>
              <th scope="col">{t('ops.health.schedule')}</th>
              <th scope="col">{t('ops.health.lastRun')}</th>
              <th scope="col">{t('ops.health.status')}</th>
            </tr>
          </thead>
          <tbody>
            {h.cron_jobs.map((job) => (
              <tr key={job.name} data-health={cronHealth(job)}>
                <td className="font-mono">{job.name}</td>
                <td className="font-mono">{job.schedule}</td>
                <td>
                  {job.last_start ? time.format(new Date(job.last_start)) : t('ops.health.never')}
                </td>
                <td>
                  <Badge tone={cronHealth(job) === 'warning' ? 'warning' : 'success'}>
                    {!job.active
                      ? t('ops.health.inactive')
                      : job.last_status
                        ? t(`ops.health.run.${job.last_status}`, { defaultValue: job.last_status })
                        : t('ops.health.never')}
                  </Badge>
                  {job.last_message ? (
                    <p className="mt-1 break-words font-mono text-sm text-muted">
                      {job.last_message}
                    </p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-sm text-muted">
        {t('ops.health.asOf', { time: h.as_of ? time.format(new Date(h.as_of)) : '' })}
      </p>
    </div>
  );
}
