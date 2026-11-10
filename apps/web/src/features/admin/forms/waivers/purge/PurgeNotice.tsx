import { localDateTimeValue } from '@qm/domain';
import { Button } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../../../lib/translation.tsx';
import { useCurrentLocation } from '../../../../auth/current.ts';
import { useExportWaivers, waiverRetentionQuery } from '../api.ts';
import { downloadCsv, waiversToCsv } from '../csv.ts';
import { expiringWaiversQuery } from './api.ts';

/**
 * The export-before-purge safety net (W5): when waiver records are due for deletion within 30 days,
 * say so and offer one click to download exactly those records. The purge is never delayed by this.
 */
export function PurgeNotice({ orgId, locationId }: { orgId: string; locationId: string }) {
  const { t } = useTranslation('admin-forms');
  const { location } = useCurrentLocation();
  const retention = useQuery(waiverRetentionQuery(orgId));
  const expiring = useQuery({
    ...expiringWaiversQuery(orgId, retention.data ?? 365),
    enabled: retention.data !== undefined,
  });
  const exporter = useExportWaivers(locationId);
  if (!location || !expiring.data || expiring.data.count === 0 || !expiring.data.oldest)
    return null;
  const day = (iso: string) => localDateTimeValue(iso, location.tz).slice(0, 10);
  const { oldest, cutoff, count } = expiring.data;
  // The export accepts at most a year; anything older was already due and is the purge's to delete.
  const to = day(cutoff);
  const floor = new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const from = day(oldest) < floor ? floor : day(oldest);
  const run = () =>
    exporter.mutate(
      { from, to },
      {
        onSuccess: (data) =>
          downloadCsv(
            `waivers-expiring-${day(cutoff)}.csv`,
            waiversToCsv(
              [
                t('waivers.col.when'),
                t('waivers.col.form'),
                t('waivers.col.version'),
                t('waivers.col.agreement'),
                t('waivers.col.guest'),
                t('waivers.col.typed'),
                t('waivers.col.guardian'),
                t('waivers.col.signed'),
                t('waivers.col.for'),
                t('waivers.col.hash'),
              ],
              data,
            ),
          ),
      },
    );
  return (
    <section
      className="flex flex-col gap-2 rounded-control border border-border p-3"
      aria-labelledby="waiver-purge-title"
      data-testid="waiver-purge-notice"
    >
      <h3 id="waiver-purge-title" className="font-medium">
        {t('waivers.purge.title', { count })}
      </h3>
      <p className="text-sm">{t('waivers.purge.body', { date: day(oldest) })}</p>
      <Button className="self-start" loading={exporter.isPending} onClick={run}>
        {t('waivers.purge.export')}
      </Button>
      <p role="alert" className="text-sm font-medium text-danger-strong empty:hidden">
        {exporter.isError ? t('errors.unknown') : null}
      </p>
    </section>
  );
}
