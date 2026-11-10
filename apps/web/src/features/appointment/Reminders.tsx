import { Button, Card } from '@qm/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { guestRpc } from '../guest/client.ts';
import { isIOS, pushSupport, subscribeToPush, type PushStep } from '../guest/push.ts';

const flag = (token: string) => `qm:apush:${token}`;

function enabledBefore(token: string): boolean {
  try {
    return localStorage.getItem(flag(token)) === '1';
  } catch {
    return false;
  }
}

/**
 * "Remind me" on the appointment page (A-7). Web push is the free channel; iPhones need the page
 * on the Home Screen, which the hint says plainly. Where push can't work the opt-in is hidden and
 * a plain note stays. When the reminders go out is the location's setting, so no times are quoted.
 */
export function Reminders({ token }: { token: string }) {
  const { t } = useTranslation('booking');
  const [support] = useState(pushSupport);
  const [step, setStep] = useState<PushStep | null>(null);
  const enable = useMutation({
    mutationFn: async () => {
      const keys = await subscribeToPush(setStep);
      await guestRpc('guest_register_appointment_push', {
        p_token: token,
        p_endpoint: keys.endpoint,
        p_p256dh: keys.p256dh,
        p_auth: keys.auth,
      });
      try {
        localStorage.setItem(flag(token), '1');
      } catch {
        // private mode: the button comes back on reload, registering again changes nothing
      }
    },
  });
  const on = enable.isSuccess || enabledBefore(token);
  const code = enable.error?.message;
  const failure = code === 'denied' ? 'denied' : enable.error ? 'failed' : null;

  return (
    <Card className="flex flex-col gap-2" data-testid="reminders">
      <h2 className="text-lg font-semibold">{t('appointment.reminders.title')}</h2>
      <p>{t('appointment.reminders.body')}</p>
      {on ? (
        <p role="status">{t('appointment.reminders.on')}</p>
      ) : support === 'available' ? (
        <>
          <Button
            variant="secondary"
            loading={enable.isPending}
            loadingLabel={t('appointment.reminders.enabling')}
            onClick={() => enable.mutate()}
          >
            {t('appointment.reminders.enable')}
          </Button>
          {enable.isPending && step === 'permission' ? (
            <p aria-live="polite" className="text-sm text-muted">
              {t('appointment.reminders.enabling')}
            </p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-sm font-medium text-danger-strong">
              {t(`appointment.reminders.${failure}`)}
            </p>
          ) : null}
        </>
      ) : support === 'needs_home_screen' ? (
        <p className="text-sm text-muted">{t('appointment.reminders.homeScreen')}</p>
      ) : support === 'blocked' ? (
        <p className="text-sm text-muted">{t('appointment.reminders.denied')}</p>
      ) : (
        <p className="text-sm text-muted">
          {isIOS() ? t('appointment.reminders.keepOpen') : t('appointment.reminders.unsupported')}
        </p>
      )}
    </Card>
  );
}
