import { Button } from '@qm/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { authErrorCode, useResendConfirmation } from './api.ts';
import { useAuthCaptcha } from './AuthCaptcha.tsx';
import { nextSearch } from './next.ts';

/** Seconds before the confirmation email can be asked for again. */
export const RESEND_WAIT_SECONDS = 60;

/**
 * Under the confirmation-code form: a countdown, then a way out for the person whose email never
 * came. The text is the same whether or not the address has an account, so it reveals nothing.
 * After the wait it points at sign-in and password reset (an existing address gets no
 * confirmation email) and offers one resend, which starts the wait again.
 */
export function ResendEmail({ email, next }: { email: string; next: string }) {
  const { t } = useTranslation('auth');
  const resend = useResendConfirmation();
  const captcha = useAuthCaptcha();
  const [secondsLeft, setSecondsLeft] = useState(RESEND_WAIT_SECONDS);

  const counting = secondsLeft > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  const waiting = counting;
  const failed = resend.error ? t(`errors.${authErrorCode(resend.error)}`) : undefined;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {waiting ? (
        <p>{t('resend.wait', { seconds: secondsLeft })}</p>
      ) : (
        <>
          <p>{t('resend.noEmail')}</p>
          <p className="flex flex-wrap gap-x-4">
            <Link
              to="/auth/sign-in"
              search={nextSearch(next)}
              className="inline-flex min-h-target items-center font-medium underline"
            >
              {t('resend.signIn')}
            </Link>
            <Link
              to="/auth/forgot-password"
              className="inline-flex min-h-target items-center font-medium underline"
            >
              {t('resend.forgot')}
            </Link>
          </p>
        </>
      )}
      {failed ? (
        <p role="alert" className="text-danger-strong font-medium">
          {failed}
        </p>
      ) : null}
      {resend.isSuccess && waiting ? <p role="status">{t('resend.sent')}</p> : null}
      {captcha.widget}
      <Button
        variant="secondary"
        loading={resend.isPending}
        loadingLabel={t('working')}
        disabled={waiting || !captcha.ready}
        onClick={() =>
          resend.mutate(
            { email, next, captchaToken: captcha.token },
            {
              onSuccess: () => setSecondsLeft(RESEND_WAIT_SECONDS),
              onSettled: captcha.refresh,
            },
          )
        }
      >
        {t('resend.button')}
      </Button>
    </div>
  );
}
