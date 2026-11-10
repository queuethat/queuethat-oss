import { Button, Input } from '@qm/ui';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from '../../lib/translation.tsx';
import { authErrorCode, useSession, useSetPassword } from '../../features/auth/api.ts';
import { AuthCard } from '../../features/auth/AuthForm.tsx';
import { DEFAULT_NEXT } from '../../features/auth/next.ts';

// The recovery link or code leaves a session behind; this screen spends it on a new password.
export const Route = createFileRoute('/auth/reset-password')({
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const session = useSession();
  const setPassword = useSetPassword();

  if (session.isSuccess && !session.data) {
    return (
      <AuthCard title={t('reset.title')} error={t('reset.noSession')}>
        <Link
          to="/auth/forgot-password"
          className="inline-flex min-h-target items-center font-medium underline"
        >
          {t('forgot.submit')}
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title={t('reset.title')}
      error={setPassword.error ? t(`errors.${authErrorCode(setPassword.error)}`) : undefined}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const password = String(new FormData(event.currentTarget).get('password') ?? '');
          setPassword.mutate(password, {
            onSuccess: () => void navigate({ to: DEFAULT_NEXT, replace: true }),
          });
        }}
      >
        <Input
          label={t('reset.password')}
          hint={t('reset.hint')}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <Button type="submit" loading={setPassword.isPending} loadingLabel={t('working')}>
          {t('reset.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
