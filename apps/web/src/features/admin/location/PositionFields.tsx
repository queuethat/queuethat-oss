import { Button, Input } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../../lib/translation.tsx';
import { parsePosition, type LocationSettings } from './api.ts';

type Position = Pick<LocationSettings, 'lat' | 'lng' | 'geofenceM'>;

/**
 * The premises position for geofenced queues (2B-Q10): latitude, longitude and radius, with a
 * helper that fills in this device's position. No map: typing two numbers is enough.
 */
export function PositionFields({
  settings,
  readOnly,
  onChange,
}: {
  settings: Position;
  readOnly: boolean;
  onChange: (next: Partial<Position>) => void;
}) {
  const { t } = useTranslation('admin');
  const [denied, setDenied] = useState(false);
  const invalid = parsePosition(settings.lat, settings.lng) === undefined;

  function useHere() {
    setDenied(false);
    if (!navigator.geolocation) {
      setDenied(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        onChange({ lat: coords.latitude.toFixed(6), lng: coords.longitude.toFixed(6) }),
      () => setDenied(true),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  return (
    <fieldset className="flex flex-col gap-3" data-testid="position-fields">
      <legend className="font-semibold">{t('location.position')}</legend>
      <p className="text-muted">{t('location.positionHint')}</p>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('location.lat')}
          inputMode="decimal"
          readOnly={readOnly}
          value={settings.lat}
          onChange={(event) => onChange({ lat: event.target.value })}
        />
        <Input
          label={t('location.lng')}
          inputMode="decimal"
          readOnly={readOnly}
          value={settings.lng}
          onChange={(event) => onChange({ lng: event.target.value })}
        />
      </div>
      <Input
        label={t('location.geofenceM')}
        type="number"
        inputMode="numeric"
        min={10}
        max={5000}
        readOnly={readOnly}
        value={settings.geofenceM}
        onChange={(event) => onChange({ geofenceM: Math.round(Number(event.target.value)) })}
      />
      {invalid ? <p role="alert">{t('location.positionInvalid')}</p> : null}
      {denied ? <p role="alert">{t('location.positionDenied')}</p> : null}
      {readOnly ? null : (
        <Button type="button" variant="secondary" onClick={useHere}>
          {t('location.usePosition')}
        </Button>
      )}
    </fieldset>
  );
}
