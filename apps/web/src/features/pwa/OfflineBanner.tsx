import { useTranslation } from '../../lib/translation.tsx';
import { useOnline } from './useOnline.ts';

/** Shown on every page while the device has no connection; the shell itself comes from the service worker. */
export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  if (online) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3 bg-neutral-strong px-4 py-2 text-center text-on-primary"
      role="status"
      data-testid="offline-banner"
    >
      {t('pwa.offline')}
    </div>
  );
}
