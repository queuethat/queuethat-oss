import { Button } from '@qm/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { pushEnabled, useEnablePush } from './api.ts';
import { isIOS, type PushStep, pushSupport } from './push.ts';

/** How long the push service may take before the guest hears it can take up to a minute. */
export const SLOW_HINT_MS = 5_000;

/**
 * "Alert me when it's my turn" on the status page (N5, N-1/P-3). Honest about iPhones: Safari
 * tabs can't get web push, so they get the Add to Home Screen hint and the keep-open fallback.
 * While the browser waits, says what on (its permission prompt, then a push service that can take
 * most of a minute on a fresh profile, #521); a timeout leaves the button to try again.
 */
export function PushOptIn({ token }: { token: string }) {
  const { t } = useTranslation('guest');
  const enable = useEnablePush(token);
  const [support] = useState(pushSupport);
  const on = enable.isSuccess || pushEnabled(token);
  const [step, setStep] = useState<PushStep | null>(null);
  const [slow, setSlow] = useState(false);
  const subscribing = enable.isPending && step === 'subscribing';

  useEffect(() => {
    if (!subscribing) return;
    const timer = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, [subscribing]);

  if (on) {
    return (
      <p role="status" className="text-center text-sm text-muted">
        {t('status.push.on')}
      </p>
    );
  }
  if (support === 'needs_home_screen') {
    return <p className="text-sm text-muted">{t('status.push.homeScreen')}</p>;
  }
  if (support === 'available') {
    const code = enable.error?.message;
    const failure = code === 'denied' || code === 'timeout' ? code : enable.error ? 'failed' : null;
    const hint =
      enable.isPending && step === 'permission' ? 'prompt' : subscribing && slow ? 'slow' : null;
    return (
      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          className="min-h-target-big w-full"
          loading={enable.isPending}
          loadingLabel={t('status.push.enabling')}
          onClick={() => {
            setSlow(false);
            enable.mutate(setStep);
          }}
        >
          {t('status.push.enable')}
        </Button>
        {hint ? (
          <p aria-live="polite" className="text-sm text-muted">
            {t(`status.push.${hint}`)}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-sm font-medium text-danger-strong">
            {t(`status.push.${failure}`)}
          </p>
        ) : null}
      </div>
    );
  }
  if (support === 'blocked') return <p className="text-sm text-muted">{t('status.push.denied')}</p>;
  return isIOS() ? <p className="text-sm text-muted">{t('status.keepOpen')}</p> : null;
}
