import { BigButton } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';

/** Switches spoken guidance on or off. Shown only in accessibility mode, next to its button. */
export function AudioButton({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useTranslation('kiosk');
  return (
    <BigButton
      variant="secondary"
      aria-pressed={on}
      onClick={() => onToggle(!on)}
      className="w-auto!"
      data-testid="audio-toggle"
    >
      {t('a11y.audio')}
    </BigButton>
  );
}
