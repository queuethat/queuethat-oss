import { Button, Input } from '@qm/ui';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import {
  authErrorCode,
  useResendConfirmation,
  useSendSignInLink,
  useSignIn,
} from '../../features/auth/api.ts';
import { useAuthCaptcha } from '../../features/auth/AuthCaptcha.tsx';
import { AuthCard, readCredentials } from '../../features/auth/AuthForm.tsx';
import { CodeForm } from '../../features/auth/CodeForm.tsx';
import { safeNext } from '../../features/auth/next.ts';
import { ResendEmail } from '../../features/auth/ResendEmail.tsx';

export const Route = createFileRoute('/auth/sign-in')({
  validateSearch: (search): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  component: SignInPage,
});

function SignInPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const next = safeNext(Route.useSearch().next);
  const signIn = useSignIn();
  const sendLink = useSendSignInLink();
  const captcha = useAuthCaptcha();
  const resendConfirmation = useResendConfirmation();
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const [confirmSentTo, setConfirmSentTo] = useState<string | null>(null);

  const failed = signIn.error ?? sendLink.error ?? resendConfirmation.error;
  // Only a correct password reveals that the account is unconfirmed, so offering a resend here
  // tells nobody anything they couldn't already do by signing up again.
  const unconfirmedEmail =
    signIn.error && authErrorCode(signIn.error) === 'email_not_confirmed'
      ? signIn.variables?.email
      : undefined;
  const busy = signIn.isPending || sendLink.isPending;

  return (
    <AuthCard
      title={t('signIn.title')}
      error={failed ? t(`errors.${authErrorCode(failed)}`) : undefined}
      footer={
        <>
          {t('signIn.noAccount')}{' '}
          <Link
            to="/auth/sign-up"
            search={{ next }}
            className="inline-flex min-h-target items-center font-medium underline"
          >
            {t('signIn.toSignUp')}
          </Link>
        </>
      }
    >
      {confirmSentTo ? (
        <>
          <p role="status">{t('signUp.sent', { email: confirmSentTo })}</p>
          <CodeForm email={confirmSentTo} type="signup" next={next} />
          <ResendEmail email={confirmSentTo} next={next} />
        </>
      ) : linkSentTo ? (
        <>
          <p role="status">{t('signIn.linkSent', { email: linkSentTo })}</p>
          <CodeForm email={linkSentTo} type="email" next={next} />
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            sendLink.reset();
            signIn.mutate(
              { ...readCredentials(event), captchaToken: captcha.token },
              { onSuccess: () => void navigate({ to: next }), onSettled: captcha.refresh },
            );
          }}
        >
          <Input label={t('email')} name="email" type="email" autoComplete="email" required />
          <Input
            label={t('password')}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Link
            to="/auth/forgot-password"
            className="inline-flex min-h-target items-center self-start text-sm font-medium underline"
          >
            {t('signIn.forgot')}
          </Link>
          {captcha.widget}
          {unconfirmedEmail ? (
            <Button
              variant="secondary"
              loading={resendConfirmation.isPending}
              loadingLabel={t('working')}
              disabled={busy || !captcha.ready}
              onClick={() =>
                resendConfirmation.mutate(
                  { email: unconfirmedEmail, next, captchaToken: captcha.token },
                  {
                    onSuccess: () => {
                      signIn.reset();
                      setConfirmSentTo(unconfirmedEmail);
                    },
                    onSettled: captcha.refresh,
                  },
                )
              }
            >
              {t('signIn.resendConfirmation')}
            </Button>
          ) : null}
          <Button
            type="submit"
            loading={signIn.isPending}
            loadingLabel={t('working')}
            disabled={busy || !captcha.ready}
          >
            {t('signIn.submit')}
          </Button>
          <Button
            variant="secondary"
            loading={sendLink.isPending}
            loadingLabel={t('working')}
            disabled={busy || !captcha.ready}
            onClick={(event) => {
              const input = event.currentTarget.form?.elements.namedItem('email');
              if (!(input instanceof HTMLInputElement) || !input.reportValidity()) return;
              signIn.reset();
              const email = input.value.trim();
              sendLink.mutate(
                { email, next, captchaToken: captcha.token },
                { onSuccess: () => setLinkSentTo(email), onSettled: captcha.refresh },
              );
            }}
          >
            {t('signIn.sendLink')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
