import { Card } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from '../../../lib/translation.tsx';
import { selectLocation } from '../../auth/current.ts';
import type { LocationTile } from './api.ts';

/** Longest wait first, then by name; locations with nobody waiting last. */
export function byLongestWait(tiles: LocationTile[]): LocationTile[] {
  return [...tiles].sort(
    (a, b) => (b.longestWaitMin ?? -1) - (a.longestWaitMin ?? -1) || a.name.localeCompare(b.name),
  );
}

/** One tile per location; a tile makes that location current and opens its dashboard. */
export function LocationTiles({ tiles }: { tiles: LocationTile[] }) {
  const { t } = useTranslation('admin');
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((tile) => (
        <li key={tile.locationId}>
          <Link
            to="/admin"
            onClick={() => selectLocation(tile.locationId)}
            className="block min-h-12 rounded-card focus-visible:outline-2"
            data-testid={`overview-${tile.name}`}
          >
            <Card className="flex flex-col gap-2">
              <h2 className="text-lg font-semibold">{tile.name}</h2>
              <p data-testid="overview-waiting">{t('overview.waiting', { count: tile.waiting })}</p>
              <p>{t('overview.queuesOpen', { count: tile.queuesOpen })}</p>
              {tile.longestWaitMin !== null && (
                <p>{t('overview.longest', { minutes: tile.longestWaitMin })}</p>
              )}
              {tile.etaLow !== null && tile.etaHigh !== null && (
                <p>{t('overview.eta', { low: tile.etaLow, high: tile.etaHigh })}</p>
              )}
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
