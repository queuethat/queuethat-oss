import { Button, Card, Input } from '@qm/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../../auth/current.ts';
import { isoDay } from '../../analytics/csv.ts';
import { useExportWaivers, type WaiverExport as Data } from './api.ts';
import { downloadCsv, localStamp, waiversToCsv } from './csv.ts';
import { PurgeNotice } from './purge/PurgeNotice.tsx';
import { WaiverRetention } from './WaiverRetention.tsx';

const KNOWN_ERRORS = ['permission_denied', 'invalid_input'];

/**
 * Manager-only export of the location's waiver records for a date range (W4): download a CSV, or
 * print the table (the browser saves it as PDF). The database logs every export.
 */
export function WaiverExport() {
  const { t } = useTranslation('admin-forms');
  const { location } = useCurrentLocation();
  const org = useCurrentOrg();
  const exporter = useExportWaivers(location?.id ?? '');
  const [from, setFrom] = useState(isoDay(30));
  const [to, setTo] = useState(isoDay());
  const [data, setData] = useState<Data | null>(null);

  // Printing shows only the table; the flag is removed again when the dialog closes.
  useEffect(() => {
    const done = () => document.body.removeAttribute('data-print-waivers');
    window.addEventListener('afterprint', done);
    return () => {
      window.removeEventListener('afterprint', done);
      done();
    };
  }, []);

  if (!location) return null;
  const run = () => exporter.mutate({ from, to }, { onSuccess: setData });
  const headers: string[] = [
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
  ];
  const download = () => {
    if (data) downloadCsv(`waivers-${from}-to-${to}.csv`, waiversToCsv(headers, data));
  };
  const print = () => {
    document.body.setAttribute('data-print-waivers', '');
    window.print();
  };
  const failure = exporter.error
    ? `errors.${KNOWN_ERRORS.includes(exporter.error.message) ? exporter.error.message : 'unknown'}`
    : null;

  return (
    <Card className="flex flex-col gap-3" data-testid="waiver-export">
      <h2 className="text-lg font-semibold">{t('waivers.title')}</h2>
      <p className="text-sm text-muted">{t('waivers.intro')}</p>
      {org ? <PurgeNotice orgId={org.id} locationId={location.id} /> : null}
      {org ? (
        <WaiverRetention orgId={org.id} canEdit={org.role === 'admin' || org.role === 'owner'} />
      ) : null}
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Input
          label={t('waivers.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          label={t('waivers.to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <Button loading={exporter.isPending} onClick={run} disabled={!from || !to}>
          {t('waivers.load')}
        </Button>
      </div>
      <p role="alert" className="text-sm font-medium text-danger-strong empty:hidden">
        {failure ? t(failure as 'errors.unknown') : null}
      </p>
      {data ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm" role="status">
            {t('waivers.count', { count: data.rows.length })}
          </p>
          {data.truncated ? <p className="text-sm font-medium">{t('waivers.truncated')}</p> : null}
          {data.rows.length > 0 ? (
            <div className="flex gap-2 print:hidden">
              <Button variant="secondary" onClick={download}>
                {t('waivers.csv')}
              </Button>
              <Button variant="secondary" onClick={print}>
                {t('waivers.print')}
              </Button>
            </div>
          ) : null}
          {data.rows.length > 0 ? (
            <div className="waiver-print overflow-x-auto">
              <h3 className="hidden print:block">
                {t('waivers.printTitle', { location: location.name, from, to })}
              </h3>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {headers.slice(0, 8).map((h) => (
                      <th key={h} className="p-1 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr
                      key={`${r.acceptedAt}-${r.textHash}-${r.typedName}-${r.guestName}`}
                      className="border-t border-border"
                    >
                      <td className="p-1">{localStamp(r.acceptedAt, data.timezone)}</td>
                      <td className="p-1">{r.form}</td>
                      <td className="p-1">{r.version}</td>
                      <td className="p-1">{r.agreement}</td>
                      <td className="p-1">{r.guestName}</td>
                      <td className="p-1">{r.typedName}</td>
                      <td className="p-1">{r.guardianName}</td>
                      <td className="p-1">
                        {r.signedAt ? localStamp(r.signedAt, data.timezone) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
