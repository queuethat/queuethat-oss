import { Button, Card } from '@qm/ui';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import type { Geo } from './captcha/publicJoin.ts';

/**
 * Asks the guest to share their position once, when a queue is for people on site (2B-Q10, Q-14).
 * The browser asks for permission only on the tap, never on page load. A refusal explains the
 * alternative (ask staff) and stops there: nothing asks again by itself.
 */
export default function ShareLocation({
  geo,
  onShared,
}: {
  geo: Geo | null;
  onShared: (geo: Geo) => void;
}) {
  const { t } = useTranslation('guest');
  const [state, setState] = useState<'idle' | 'asking' | 'denied'>('idle');

  function share() {
    if (!navigator.geolocation) {
      setState('denied');
      return;
    }
    setState('asking');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setState('idle');
        onShared({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracyM: Math.round(coords.accuracy),
        });
      },
      () => setState('denied'),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  return (
    <Card className="flex flex-col gap-2" data-testid="share-location">
      <h2 className="text-lg font-semibold">{t('join.location.title')}</h2>
      <p>{t('join.location.why')}</p>
      {geo ? (
        <p role="status">{t('join.location.shared')}</p>
      ) : (
        <Button
          variant="secondary"
          type="button"
          onClick={share}
          loading={state === 'asking'}
          loadingLabel={t('join.location.asking')}
        >
          {t('join.location.share')}
        </Button>
      )}
      {state === 'denied' ? <p role="alert">{t('join.location.denied')}</p> : null}
    </Card>
  );
}
