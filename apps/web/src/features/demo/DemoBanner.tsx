import { useTranslation } from '../../lib/translation.tsx';
import { appConfig } from '../../lib/config.ts';

/** Shown on every page of a self-hosted install started with DEMO_MODE=true; clean installs never see it. */
export function DemoBanner() {
  const { t } = useTranslation();
  if (!appConfig().demoMode) return null;
  return (
    <div
      className="bg-warning-soft px-4 py-1 text-center text-sm text-warning-strong"
      role="note"
      data-testid="demo-banner"
    >
      {t('demo.banner')}
    </div>
  );
}
