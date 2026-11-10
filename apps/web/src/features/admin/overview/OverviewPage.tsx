import { EmptyState, PageHeader, Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentOrg } from '../../auth/current.ts';
import { overviewQuery } from './api.ts';
import { LocationTiles } from './LocationTiles.tsx';

/**
 * `/admin/overview` (2B-ORG4, #268): one tile per location from `api.org_overview`, refreshed
 * every 30 s. A tile opens that location's dashboard.
 */
export function OverviewPage() {
  const { t, i18n } = useTranslation('admin');
  const org = useCurrentOrg();
  const tiles = useQuery({ ...overviewQuery(org?.id ?? ''), enabled: !!org });
  if (!org || tiles.isPending) return <Skeleton label={t('overview.loading')} rows={2} />;
  if (tiles.isError) return <p role="alert">{t('overview.error')}</p>;
  const asOf = tiles.data[0]?.asOf;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-8">
      <PageHeader title={t('overview.title')} />
      {tiles.data.length === 0 ? (
        <EmptyState title={t('overview.empty')} />
      ) : (
        <LocationTiles tiles={tiles.data} />
      )}
      {asOf && (
        <p className="text-sm text-muted">
          {t('overview.asOf', { time: new Date(asOf).toLocaleTimeString(i18n.language) })}
        </p>
      )}
    </div>
  );
}
