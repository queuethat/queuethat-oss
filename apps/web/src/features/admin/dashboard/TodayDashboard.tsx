import { Card, ConnectionIndicator, PageHeader, Spinner } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { formatAsOf, useConnectionState } from '../../../lib/live.ts';
import { LocationRollup } from '../overview/LocationRollup.tsx';
import { EndOfDayCard } from './EndOfDayCard.tsx';
import { RightNow } from './RightNowCard.tsx';
import { useTodayStats } from './api.ts';
import { useSetupProgress, useSetupState } from './setup/api.ts';
import { doneSteps, SetupChecklist } from './setup/SetupChecklist.tsx';

const TILES = [
  'waiting_now',
  'avg_wait_minutes',
  'joined',
  'served',
  'no_shows',
  'cancelled',
] as const;

/** Admin home: today's waiting, average wait, joined, served, no-shows and cancelled, kept live. */
export function TodayDashboard() {
  const { t, i18n } = useTranslation('admin');
  const { location } = useCurrentLocation();
  const stats = useTodayStats(location?.id);
  const connection = useConnectionState();
  const data = stats.data;
  const org = useCurrentOrg();
  const isManager = org?.role === 'owner' || org?.role === 'admin' || org?.role === 'manager';
  const setup = useSetupState(org?.id, location?.id).data;
  const { progress, update } = useSetupProgress(location?.id);
  // Until the first visit exists, the checklist replaces six zero tiles. The setup facts only
  // load for managers and above, so staff never see it.
  const checklist =
    setup && !progress.dismissed && !Object.values(doneSteps(setup, progress)).every(Boolean);
  const showTiles = !(checklist && setup && !setup.has_visit);

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-8">
      <PageHeader
        title={t('today.title')}
        actions={
          <ConnectionIndicator state={connection} label={t(`today.connection.${connection}`)} />
        }
      />
      {showTiles ? <RightNow locationId={location?.id} timeZone={location?.tz ?? 'UTC'} /> : null}
      <LocationRollup />
      {checklist && setup ? (
        <SetupChecklist facts={setup} progress={progress} onProgress={update} />
      ) : null}
      {!showTiles ? null : !data ? (
        stats.isError ? (
          <p role="alert">{t('today.error')}</p>
        ) : (
          <Spinner label={t('today.loading')} />
        )
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {TILES.map((tile) => (
              <Card key={tile} data-testid={`stat-${tile}`}>
                <dt className="text-sm text-muted">{t(`today.stats.${tile}`)}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {tile === 'avg_wait_minutes'
                    ? data.avg_wait_minutes == null
                      ? t('today.noWaitYet')
                      : t('today.minutes', { count: Number(data.avg_wait_minutes) })
                    : (data[tile] ?? 0)}
                </dd>
              </Card>
            ))}
          </dl>
          {isManager ? <EndOfDayCard stats={data} timeZone={location?.tz ?? 'UTC'} /> : null}
          <p className="text-sm text-muted">
            {t('today.asOf', { time: data.as_of ? formatAsOf(data.as_of, i18n.language) : '' })}
          </p>
        </>
      )}
    </section>
  );
}
