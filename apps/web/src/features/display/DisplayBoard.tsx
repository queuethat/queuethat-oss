import { useSession } from '../auth/api.ts';
import { useDisplaySnapshot, useLocationTimeZone, useOnsiteCode } from './api.ts';
import { BoardView } from './BoardView.tsx';
import { useAnnounceSettings } from './announce/api.ts';
import { useAnnouncements } from './announce/useAnnouncements.ts';
import { SoundControls } from './announce/SoundControls.tsx';
import { SlidePanel } from './signage/SlidePanel.tsx';
import { useDisplaySignage } from './signage/api.ts';
import { OnsiteCodePanel } from './OnsiteCodePanel.tsx';
import { useWakeLock } from './useWakeLock.ts';

/**
 * The waiting-room TV for the paired device's location: per queue, who is being served at which
 * counter and who is next. Shows ticket numbers, and a first name only when the location turned
 * names on (the snapshot decides). New calls are highlighted for a few seconds.
 */
export function DisplayBoard() {
  const { data: session } = useSession();
  const locationId = session?.user.app_metadata?.location_id as string | undefined;
  const snapshot = useDisplaySnapshot(locationId);
  const timeZone = useLocationTimeZone(locationId);
  const onsite = useOnsiteCode(locationId);
  const announce = useAnnounceSettings(locationId);
  const signage = useDisplaySignage(locationId);
  const sound = useAnnouncements(snapshot.data, undefined, announce);
  useWakeLock();
  return (
    <>
      <BoardView
        snapshot={snapshot.data}
        failed={snapshot.isError}
        timeZone={timeZone.data}
        panel={(calls) => <SlidePanel slides={signage.data ?? []} calls={calls} />}
      />
      <SoundControls
        mode={sound.mode}
        unlocked={sound.unlocked}
        onMode={sound.setMode}
        onUnlock={sound.unlock}
        onTest={sound.test}
      />
      {onsite.data ? <OnsiteCodePanel onsite={onsite.data} /> : null}
    </>
  );
}
