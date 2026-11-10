import { BigButton, Button, Card } from '@qm/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { useAlertSound } from '../../lib/sound.ts';
import type { ConsoleVisit } from './api.ts';

/**
 * C8 (#65, N-14): a chime on this tablet when someone joins any queue at the location. Browsers
 * block sound until a tap, so a banner asks for one on every page load; after that a persistent
 * indicator says whether sound is on, with a speaker test and mute. `visits` is the console's
 * live list; a visit id not seen before that is waiting counts as an arrival.
 */
export function SoundAlerts({
  visits,
  reminderIds = [],
}: {
  visits: ConsoleVisit[] | undefined;
  /** Serving visits past their reminder threshold (#144); each chimes once. */
  reminderIds?: string[];
}) {
  const { t } = useTranslation('staff');
  const sound = useAlertSound();
  const [muted, setMuted] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const ring = sound.enabled && !muted;
  const { play } = sound;

  useEffect(() => {
    if (!visits) return;
    // The first list is what was already there, not arrivals.
    const arrived = seen.current
      ? visits.some((v) => v.status === 'waiting' && !seen.current?.has(v.id))
      : false;
    seen.current = new Set([...(seen.current ?? []), ...visits.map((v) => v.id)]);
    if (arrived && ring) play(2);
  }, [visits, ring, play]);

  const chimed = useRef<Set<string>>(new Set());
  const reminderKey = reminderIds.join(',');
  useEffect(() => {
    const fresh = reminderIds.filter((id) => !chimed.current.has(id));
    if (fresh.length === 0 || !ring) return;
    fresh.forEach((id) => chimed.current.add(id));
    play(1);
    // reminderKey stands for reminderIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminderKey, ring, play]);

  if (!sound.supported) return null;
  if (!sound.enabled) {
    return (
      <Card
        role="region"
        aria-label={t('console.sound.off')}
        className="flex flex-col gap-3 bg-warning-soft text-warning-strong"
      >
        <p className="font-semibold">{t('console.sound.gate')}</p>
        <p className="text-sm">{t('console.sound.muteSwitch')}</p>
        <BigButton variant="secondary" onClick={sound.enable}>
          {t('console.sound.enable')}
        </BigButton>
      </Card>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="font-semibold">
        {muted ? t('console.sound.muted') : t('console.sound.on')}
      </p>
      {muted ? null : (
        <Button variant="secondary" onClick={() => play(2)}>
          {t('console.sound.test')}
        </Button>
      )}
      <Button variant="secondary" onClick={() => setMuted(!muted)}>
        {muted ? t('console.sound.unmute') : t('console.sound.mute')}
      </Button>
      {muted ? null : <p className="text-sm text-muted">{t('console.sound.muteSwitch')}</p>}
    </div>
  );
}
