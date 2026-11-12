import { Icon, iconAlertTriangle } from '@qm/ui';
import { useTranslation } from '../../../../lib/translation.tsx';

/**
 * Shown above the builder whenever a form holds an agreement or signature, and on every sample
 * waiver: the text is a starting point, not legal advice, and signed records are deleted on the
 * waiver retention schedule. It never says a waiver is binding.
 */
export function WaiverBanner() {
  const { t } = useTranslation('admin-form-builder');
  return (
    <div
      role="note"
      data-testid="waiver-banner"
      className="flex gap-3 rounded-control border border-warning-strong bg-warning-soft p-3 text-sm"
    >
      <Icon icon={iconAlertTriangle} size="sm" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">{t('waiverBanner.title')}</p>
        <p>{t('waiverBanner.retention')}</p>
      </div>
    </div>
  );
}
