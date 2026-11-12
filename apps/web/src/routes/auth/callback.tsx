import { Button, Input, Spinner } from '@qm/ui';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/translation.tsx';
import {
  authErrorCode,
  useRequestPasswordReset,
  useSendSignInLink,
  useSession,
} from '../../features/auth/api.ts';
import { useAuthCaptcha } from '../../features/auth/AuthCaptcha.tsx';
import { AuthCard } from '../../features/auth/AuthForm.tsx';
import { CodeForm } from '../../features/auth/CodeForm.tsx';
import { nextSearch, RESET_PATH, safeNext } from '../../features/auth/next.ts';

// Emailed links (sign-up confirmation, sign-in link) land here. The Supabase client reads the
// session out of the URL fragment as it starts; this screen waits for it, then moves on.
export const Route = createFileRoute('/auth/callback')({
  validateSearch: (search): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  component: CallbackPage,
});

/** Supabase reports a failed link as `error_code` in the fragment (or the query, for PKCE). */
function linkErrorCode(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  return hash.get('error_code') ?? query.get('error_code') ?? (hash.has('error') ? '' : null);
}

function CallbackPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const next = safeNext(Route.useSearch().next);
  const [linkError] = useState(linkErrorCode);
  const session = useSession();
  const signedIn = Boolean(session.data);

  useEffect(() => {
    if (signedIn) void navigate({ to: next, replace: true });
  }, [signedIn, navigate, next]);

  const failed = linkError !== null || session.isError || (session.isSuccess && !session.data);
  if (!failed) {
    return (
      <AuthCard title={t('callback.title')}>
        <Spinner label={t('working')} />
      </AuthCard>
    );
  }
  // A code still in the URL means the exchange failed: the link was opened in another browser
  // than the one that asked for it (PKCE). A sign-up link has still confirmed the address.
  const code = linkError
    ? authErrorCode(linkError)
    : new URLSearchParams(window.location.search).has('code')
      ? 'link_other_browser'
      : 'link_invalid';
  return (
    <AuthCard title={t('callback.failedTitle')} error={t(`errors.${code}`)}>
      <FreshCode next={next} />
      <Link
        to="/auth/sign-in"
        search={nextSearch(next)}
        className="inline-flex min-h-target items-center font-medium underline"
      >
        {t('callback.back')}
      </Link>
    </AuthCard>
  );
}

/**
 * A link that fails here has still been used up (including its code), so ask for a new email
 * whose code works in this browser: a sign-in code, or a reset code when the link was a reset.
 */
function FreshCode({ next }: { next: string }) {
  const { t } = useTranslation('auth');
  const reset = next === RESET_PATH;
  const signIn = useSendSignInLink();
  const recovery = useRequestPasswordReset();
  const captcha = useAuthCaptcha();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const request = reset ? recovery : signIn;
  if (sentTo) {
    return (
      <>
        <p role="status">{t('callback.codeSent', { email: sentTo })}</p>
        <CodeForm email={sentTo} type={reset ? 'recovery' : 'email'} next={next} />
      </>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
        const options = { onSuccess: () => setSentTo(email), onSettled: captcha.refresh };
        if (reset) recovery.mutate({ email, captchaToken: captcha.token }, options);
        else signIn.mutate({ email, next, captchaToken: captcha.token }, options);
      }}
    >
      <p>{t(reset ? 'callback.freshReset' : 'callback.freshCode')}</p>
      <Input
        label={t('email')}
        name="email"
        type="email"
        autoComplete="email"
        error={request.error ? t(`errors.${authErrorCode(request.error)}`) : undefined}
        required
      />
      {captcha.widget}
      <Button
        type="submit"
        loading={request.isPending}
        loadingLabel={t('working')}
        disabled={!captcha.ready}
      >
        {t(reset ? 'callback.freshResetSubmit' : 'callback.freshCodeSubmit')}
      </Button>
    </form>
  );
}
