import { Button, PageHeader, Select, Skeleton } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { canEditLocation } from '../location/api.ts';
import { useDataExport, type ExportFormat } from './api.ts';

/**
 * `/admin/export` (2P-RPT5, #201): download everything the organization has stored as a zip of CSV
 * or JSON Lines files. Owners and admins only; the database enforces it and counts the daily limit.
 */
export function ExportPage() {
  const { t } = useTranslation('admin');
  const role = useCurrentOrg()?.role;
  const [format, setFormat] = useState<ExportFormat>('csv');
  const run = useDataExport();
  if (!role) return <Skeleton label={t('export.loading')} rows={2} />;
  if (!canEditLocation(role))
    return (
      <div className="flex flex-col gap-4 pb-8">
        <PageHeader title={t('export.title')} description={t('export.readOnly')} />
      </div>
    );
  const code = run.error?.message ?? '';
  return (
    <div className="flex flex-col gap-4 pb-8">
      <PageHeader title={t('export.title')} description={t('export.hint')} />
      <Select
        label={t('export.format')}
        value={format}
        disabled={run.isPending}
        onChange={(e) => setFormat(e.target.value as ExportFormat)}
      >
        <option value="csv">{t('export.csv')}</option>
        <option value="jsonl">{t('export.jsonl')}</option>
      </Select>
      <div className="flex flex-wrap items-center gap-4">
        <Button disabled={run.isPending} onClick={() => run.mutate(format)}>
          {run.isPending ? t('export.preparing') : t('export.start')}
        </Button>
        <p data-testid="export-remaining" role="status">
          {run.data ? t('export.remaining', { count: run.data.remainingToday }) : t('export.limit')}
        </p>
      </div>
      {run.isSuccess ? <p role="status">{t('export.done')}</p> : null}
      {run.isError ? (
        <p role="alert" className="font-medium text-danger-strong">
          {code === 'rate_limited'
            ? t('export.error.rate_limited')
            : code === 'mfa_required'
              ? t('export.error.mfa_required')
              : code === 'permission_denied'
                ? t('export.error.permission_denied')
                : t('export.error.unknown')}{' '}
          {code === 'mfa_required' ? (
            <Link to="/auth/mfa" search={{ next: '/admin/export' }} className="underline">
              {t('export.confirm')}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
