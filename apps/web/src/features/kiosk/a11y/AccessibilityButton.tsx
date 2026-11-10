import { BigButton, Icon, iconAccessibility } from '@qm/ui';
import { useTranslation } from '../../../lib/translation.tsx';

/** On every kiosk screen: one tap switches the accessibility mode on or off. At least 56 px, icon and text. */
export function AccessibilityButton({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useTranslation('kiosk');
  return (
    <BigButton
      variant="secondary"
      aria-pressed={on}
      onClick={() => onToggle(!on)}
      className="w-auto! gap-2"
      data-testid="a11y-toggle"
    >
      <Icon icon={iconAccessibility} size="lg" />
      {t('a11y.button')}
    </BigButton>
  );
}
