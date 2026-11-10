import { Button, Input } from '@qm/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import { authErrorCode, useRequestPasswordReset } from '../../features/auth/api.ts';
import { useAuthCaptcha } from '../../features/auth/AuthCaptcha.tsx';
import { AuthCard } from '../../features/auth/AuthForm.tsx';
import { CodeForm } from '../../features/auth/CodeForm.tsx';
import { RESET_PATH } from '../../features/auth/next.ts';

// Asks for a recovery email. The code in it works on any device; the link only in this browser (PKCE).
export const Route = createFileRoute('/auth/forgot-password')({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { t } = useTranslation('auth');
  const request = useRequestPasswordReset();
  const captcha = useAuthCaptcha();
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <AuthCard
      title={t('forgot.title')}
      error={request.error ? t(`errors.${authErrorCode(request.error)}`) : undefined}
      footer={
        <Link
          to="/auth/sign-in"
          className="inline-flex min-h-target items-center font-medium underline"
        >
          {t('forgot.back')}
        </Link>
      }
    >
      {sentTo ? (
        <>
          <p role="status">{t('forgot.sent', { email: sentTo })}</p>
          <CodeForm email={sentTo} type="recovery" next={RESET_PATH} />
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
            request.mutate(
              { email, captchaToken: captcha.token },
              { onSuccess: () => setSentTo(email), onSettled: captcha.refresh },
            );
          }}
        >
          <p>{t('forgot.intro')}</p>
          <Input label={t('email')} name="email" type="email" autoComplete="email" required />
          {captcha.widget}
          <Button
            type="submit"
            loading={request.isPending}
            loadingLabel={t('working')}
            disabled={!captcha.ready}
          >
            {t('forgot.submit')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
