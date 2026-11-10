import { Skeleton } from '@qm/ui';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { useCurrentLocation, useCurrentOrg } from '../../auth/current.ts';
import { overviewQuery } from './api.ts';
import { byLongestWait, LocationTiles } from './LocationTiles.tsx';

/** The admin home's view of every location, longest wait first. Renders nothing for one location. */
export function LocationRollup() {
  const { t } = useTranslation('admin');
  const headingId = useId();
  const { locations } = useCurrentLocation();
  const org = useCurrentOrg();
  const tiles = useQuery({
    ...overviewQuery(org?.id ?? ''),
    enabled: !!org && locations.length > 1,
  });
  if (locations.length < 2) return null;
  if (tiles.isError) return <p role="alert">{t('overview.error')}</p>;
  if (!tiles.data) return <Skeleton label={t('overview.loading')} rows={2} />;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('today.locations.title')}
      </h2>
      <LocationTiles tiles={byLongestWait(tiles.data)} />
    </section>
  );
}
