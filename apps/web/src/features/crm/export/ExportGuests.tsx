import { Button } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import { downloadCsv } from '../csv.ts';
import { useExportGuests } from './api.ts';

/** Downloads the guest list as CSV, with a warning that the file holds personal data. */
export function ExportGuests() {
  const { t } = useTranslation('crm');
  const exporter = useExportGuests();
  const message =
    exporter.error?.message === 'rate_limited' ? 'export.rateLimited' : 'export.failed';
  return (
    <section aria-labelledby="export-h" className="flex flex-col gap-3">
      <h2 id="export-h" className="text-xl font-semibold">
        {t('export.title')}
      </h2>
      <p className="text-muted">{t('export.warning')}</p>
      <Button
        className="self-start"
        loading={exporter.isPending}
        loadingLabel={t('export.running')}
        onClick={() =>
          exporter.mutate(undefined, {
            onSuccess: (csv) => downloadCsv(csv, 'guests.csv'),
          })
        }
      >
        {t('export.button')}
      </Button>
      <p role="alert" className="font-medium text-danger-strong empty:hidden">
        {exporter.isError ? t(message as 'export.failed') : null}
      </p>
    </section>
  );
}
