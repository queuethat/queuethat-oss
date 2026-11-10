import { Button, Select } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';
import type { AnnounceMode } from './announce.ts';

/**
 * The TV's sound settings, kept on the device: off, chime, or chime and speech. When sound is
 * on but the browser still has audio locked (a TV just reloaded), a banner asks for a tap.
 */
export function SoundControls({
  mode,
  unlocked,
  onMode,
  onUnlock,
  onTest,
}: {
  mode: AnnounceMode;
  unlocked: boolean;
  onMode: (mode: AnnounceMode) => void;
  onUnlock: () => void;
  onTest: () => void;
}) {
  const { t } = useTranslation('display');
  return (
    <div className="mt-8 flex flex-wrap items-end gap-4" data-testid="sound-controls">
      {mode !== 'off' && !unlocked ? (
        <Button onClick={onUnlock} className="text-2xl">
          {t('announce.gate')}
        </Button>
      ) : null}
      <div className="min-w-60">
        <Select
          label={t('announce.mode.label')}
          value={mode}
          onChange={(event) => onMode(event.target.value as AnnounceMode)}
        >
          <option value="off">{t('announce.mode.off')}</option>
          <option value="chime">{t('announce.mode.chime')}</option>
          <option value="chime-speech">{t('announce.mode.speech')}</option>
        </Select>
      </div>
      {mode !== 'off' && unlocked ? (
        <Button variant="secondary" onClick={onTest}>
          {t('announce.testButton')}
        </Button>
      ) : null}
    </div>
  );
}
