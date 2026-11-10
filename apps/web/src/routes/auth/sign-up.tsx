import { Button, Input } from '@qm/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Trans, useTranslation } from '../../lib/translation.tsx';
import { authErrorCode, useSignUp } from '../../features/auth/api.ts';
import { useAuthCaptcha } from '../../features/auth/AuthCaptcha.tsx';
import { AuthCard, readCredentials } from '../../features/auth/AuthForm.tsx';
import { CodeForm } from '../../features/auth/CodeForm.tsx';
import { ResendEmail } from '../../features/auth/ResendEmail.tsx';
import { safeNext } from '../../features/auth/next.ts';
import { legalUrls } from '../../features/marketing/company.ts';
import { LegalLink } from '../../features/marketing/LegalLink.tsx';

export const Route = createFileRoute('/auth/sign-up')({
  validateSearch: (search): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  component: SignUpPage,
});

const consentLink = 'inline-flex min-h-target items-center font-medium underline';

function SignUpPage() {
  const { t } = useTranslation('auth');
  const legal = legalUrls();
  const next = safeNext(Route.useSearch().next);
  const signUp = useSignUp();
  const captcha = useAuthCaptcha();
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <AuthCard
      title={t('signUp.title')}
      panel="bento"
      error={signUp.error ? t(`errors.${authErrorCode(signUp.error)}`) : undefined}
      footer={
        <>
          {t('signUp.haveAccount')}{' '}
          <Link
            to="/auth/sign-in"
            search={{ next }}
            className="inline-flex min-h-target items-center font-medium underline"
          >
            {t('signUp.toSignIn')}
          </Link>
        </>
      }
    >
      {sentTo ? (
        <>
          <p role="status">{t('signUp.sent', { email: sentTo })}</p>
          <CodeForm email={sentTo} type="signup" next={next} />
          <ResendEmail email={sentTo} next={next} />
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            const credentials = readCredentials(event);
            signUp.mutate(
              { ...credentials, next, captchaToken: captcha.token },
              { onSuccess: () => setSentTo(credentials.email), onSettled: captcha.refresh },
            );
          }}
        >
          <Input label={t('email')} name="email" type="email" autoComplete="email" required />
          <Input
            label={t('password')}
            hint={t('passwordHint')}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          {/* The sentence names both pages, so it shows only when the operator has published both. */}
          {legal.terms && legal.privacy ? (
            <p className="text-sm text-muted" data-testid="signup-consent">
              <Trans
                t={t}
                i18nKey="signUp.consent"
                components={{
                  terms: <LegalLink href={legal.terms} className={consentLink} />,
                  privacy: <LegalLink href={legal.privacy} className={consentLink} />,
                }}
              />
            </p>
          ) : null}
          {captcha.widget}
          <Button
            type="submit"
            loading={signUp.isPending}
            loadingLabel={t('working')}
            disabled={!captcha.ready}
          >
            {t('signUp.submit')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
