import { Button } from '@qm/ui';
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { updatePolicyFor } from './updatePolicy.ts';
import { useAppUpdate } from './useAppUpdate.ts';

/** Applies app updates according to the page's update policy. */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const policy = updatePolicyFor(pathname);
  const { updateReady, apply } = useAppUpdate();
  const [dismissed, setDismissed] = useState(false);

  // Paired devices look for updates only while idle (features/device, D3 #50), so applying at once is safe.
  useEffect(() => {
    if (updateReady && policy === 'auto') apply();
  }, [updateReady, policy, apply]);

  if (!updateReady || dismissed || policy !== 'prompt') return null;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3 bg-neutral-strong px-4 py-2 text-center text-on-primary"
      role="status"
      data-testid="update-prompt"
    >
      <span>{t('pwa.updateAvailable')}</span>
      <Button onClick={apply}>{t('pwa.reload')}</Button>
      <Button variant="secondary" onClick={() => setDismissed(true)}>
        {t('pwa.later')}
      </Button>
    </div>
  );
}
