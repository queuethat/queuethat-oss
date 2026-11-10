import { Input, Select } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { selectLocation, useCurrentLocation, useCurrentOrg } from './current.ts';

const SEARCH_ABOVE = 5;

/**
 * Shows where staff are working. A picker appears only for people with more than one location,
 * with a search box above SEARCH_ABOVE of them. The choice is kept per device (current.ts).
 */
export function LocationSwitcher() {
  const { t } = useTranslation('auth');
  const { location, locations } = useCurrentLocation();
  const org = useCurrentOrg();
  const [filter, setFilter] = useState('');
  if (!location) return null;
  if (locations.length < 2) {
    return (
      <p className="min-w-0 font-medium" data-testid="current-location">
        {t('location.current', { location: location.name, org: org?.name ?? '' })}
      </p>
    );
  }
  // The current location stays listed whatever the filter says, so the picker never shows a blank.
  const needle = filter.trim().toLowerCase();
  const shown = locations.filter(
    (l) => l.id === location.id || l.name.toLowerCase().includes(needle),
  );
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      {locations.length > SEARCH_ABOVE && (
        <Input
          label={t('location.search')}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <Select
        label={t('location.label')}
        value={location.id}
        onChange={(event) => selectLocation(event.target.value)}
      >
        {shown.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
